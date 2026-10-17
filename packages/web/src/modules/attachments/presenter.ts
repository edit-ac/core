import { FRAGMENT_MIME } from '../../clipboard/fragment.js';
import type { ContentContext, ContentFactory } from '../content.js';
import type { ImageAssetDescriptor, ImageAssetIdentity } from '../images/presenter.js';

/** Same descriptor and action vocabulary as editac_core::modules::assets. */
export type AttachmentDescriptor = Omit<ImageAssetDescriptor, 'kind'> & { kind: 'file' };
export type AttachmentState = 'local' | 'queued' | 'available' | 'failed' | 'missing' | 'revoked' | 'locked' | 'offline' | 'forbidden';
export type AttachmentAction = 'open' | 'download';
export interface AttachmentRequest { version: 1; operationId: string; identity: ImageAssetIdentity; action: AttachmentAction; byteLimit: number }
export interface AttachmentAuthorization { identity: ImageAssetIdentity; state: AttachmentState; actions: readonly AttachmentAction[] }
export interface AttachmentResult { identity: ImageAssetIdentity; operationId: string; action: AttachmentAction; state: 'completed' | 'offline' | 'forbidden' | 'locked' | 'failed' }
export interface AttachmentPort {
  /** Local cached observation only. Rendering must never initiate host network work. */
  observe?(identity: Readonly<ImageAssetIdentity>): { identity: ImageAssetIdentity; state: AttachmentState };
  /** Fresh authority for this explicit operation, never inferred from metadata. */
  authorize(request: Readonly<AttachmentRequest>, signal: AbortSignal): Promise<AttachmentAuthorization>;
  /** Host rechecks authority at effect time. Open/download never implies shell execution.
   * Bytes/URLs, safe OS opening, optional PDF preview and refcounts remain host-owned.
   * Honor signal; do not retry automatically or return temporary URLs to the document. */
  execute(request: Readonly<AttachmentRequest>, signal: AbortSignal): Promise<AttachmentResult>;
  cancel?(request: Readonly<AttachmentRequest>): void;
}
export interface AttachmentOptions { attachments?: AttachmentPort; attachmentLimits?: { byteLimit?: number; timeoutMs?: number; concurrency?: number } }
export interface AttachmentClipboard { version: 1; descriptor: AttachmentDescriptor; binaryAvailable: false }
export const ATTACHMENT_CLIPBOARD_MIME = 'application/vnd.editac.attachment+json';
const equal = (a: ImageAssetIdentity | undefined, b: ImageAssetIdentity) => a?.host === b.host && a?.key === b.key;
const states = new Set<AttachmentState>(['local','queued','available','failed','missing','revoked','locked','offline','forbidden']);
function descriptor(node: ContentContext['node']): AttachmentDescriptor | undefined {
  const t = node.blockAttributes;
  if (!Array.isArray(t) || t.length !== 3 || t[0] !== 'module:editac.asset' || t[1] !== 1 || !t[2] || typeof t[2] !== 'object' || Array.isArray(t[2])) return;
  const d = t[2] as unknown as AttachmentDescriptor;
  // Rust validates shared descriptors. Check the presenter discriminator and bounded text as well.
  if (d.kind !== 'file' || !d.identity || !/^[a-zA-Z0-9_-]{1,64}$/.test(d.identity.host) || !/^[a-zA-Z0-9_-]{1,256}$/.test(d.identity.key) || !d.metadata || typeof d.metadata.filename !== 'string' || d.metadata.filename.length > 1024 || typeof d.source !== 'string' || new TextEncoder().encode(d.source).length > 1048576 || typeof d.fallback !== 'string' || d.fallback.length > 8192) return;
  return JSON.parse(JSON.stringify(d)) as AttachmentDescriptor;
}
/** Portable clipboard record contains stable data only; no grant, URL or binary claim. */
export function attachmentClipboard(value: AttachmentDescriptor): AttachmentClipboard {
  return { version: 1, descriptor: JSON.parse(JSON.stringify(value)) as AttachmentDescriptor, binaryAvailable: false };
}
/** Optional inert file rendering. Only explicit activation contacts the host. */
export function attachmentPresenters(options: AttachmentOptions = {}): ContentFactory {
  const port = options.attachments;
  if (port && (typeof port.authorize !== 'function' || typeof port.execute !== 'function' || (port.observe !== undefined && typeof port.observe !== 'function') || (port.cancel !== undefined && typeof port.cancel !== 'function'))) throw Error('Invalid attachment port');
  const limit = options.attachmentLimits ?? {}, byteLimit = limit.byteLimit ?? 67108864, timeoutMs = limit.timeoutMs ?? 15000, concurrency = limit.concurrency ?? 8;
  for (const [value, max] of [[byteLimit,67108864],[timeoutMs,30000],[concurrency,32]]) if (!Number.isSafeInteger(value) || value! < 1 || value! > max!) throw Error('Invalid attachment limit');
  let active = 0;
  return context => {
    let data = descriptor(context.node); if (!data) return;
    const doc = context.element.ownerDocument, element = doc.createElement('section'), label = doc.createElement('span'), detail = doc.createElement('span'), status = doc.createElement('span'), source = doc.createElement('textarea'), copy = doc.createElement('button');
    const buttons = (['open','download'] as const).map(action => { const b = doc.createElement('button'); b.type = 'button'; b.textContent = action === 'open' ? 'Open file' : 'Download file'; b.onclick = () => activate(action); return b; });
    element.dataset.contentModule = 'attachment'; element.contentEditable = 'false'; element.tabIndex = 0;
    status.setAttribute('role','status'); source.readOnly = true; source.setAttribute('aria-label','Attachment source'); copy.type = 'button'; copy.textContent = 'Select source to copy';
    copy.onclick = () => { source.focus(); source.select(); status.textContent = 'Copy selected source. Stable attachment identity is included; binary data is unavailable.'; };
    element.append(label,detail,status,source,copy,...buttons);
    let disposed = false, key = '', current = context.node, stop: (() => void) | undefined;
    const setState = (state: string) => { element.dataset.attachmentState = state; status.textContent = `File ${state}. Binary data is not included in source or clipboard.`; };
    const present = () => {
      element.setAttribute('aria-label',data!.metadata.filename); label.textContent = data!.metadata.filename; detail.textContent = ` — ${data!.metadata.byteLength === null ? 'Size unknown' : `${data!.metadata.byteLength} bytes`} — ${data!.fallback}`;
      if (source.value !== data!.source.replaceAll('\r\n','\n').replaceAll('\r','\n')) source.value = data!.source;
      let state: AttachmentState = 'missing';
      try { const observation = port?.observe?.(Object.freeze({...data!.identity})); if (observation && equal(observation.identity,data!.identity) && states.has(observation.state)) state = observation.state; } catch { state = 'failed'; }
      setState(state); for (const b of buttons) b.disabled = !port;
    };
    const stillCurrent = (expected: string) => !disposed && element.isConnected && key === expected && JSON.stringify(context.engine.read().visible.find(n => n.id === current.id)?.blockAttributes) === JSON.stringify(current.blockAttributes);
    async function activate(action: AttachmentAction): Promise<void> {
      if (!port || disposed || stop || !stillCurrent(key)) return;
      if (active >= concurrency) { setState('busy'); return; }
      const expected = key, captured = data!;
      const request: Readonly<AttachmentRequest> = Object.freeze({ version: 1, operationId: `attachment-${crypto.randomUUID()}`, identity: Object.freeze({...captured.identity}), action, byteLimit });
      const controller = new AbortController(); let live = true; active++;
      for (const b of buttons) b.disabled = true;
      const finish = () => { if (!live) return; live = false; clearTimeout(timer); controller.abort(); active--; stop = undefined; try { port.cancel?.(request); } catch { /* Resource release must survive host failure. */ } for (const b of buttons) b.disabled = disposed; };
      const timer = setTimeout(() => { finish(); if (stillCurrent(expected)) setState('timeout'); },timeoutMs); stop = finish; setState('authorizing');
      try {
        const grant = await port.authorize(request,controller.signal);
        if (!live || !stillCurrent(expected)) { finish(); return; }
        if (!equal(grant?.identity,captured.identity) || !Array.isArray(grant.actions) || grant.actions.length > 2 || new Set(grant.actions).size !== grant.actions.length || !grant.actions.every(a => a === 'open' || a === 'download') || !grant.actions.includes(action)) throw Error('forbidden');
        if (grant.state !== 'available' && grant.state !== 'local') throw Error(states.has(grant.state) ? grant.state : 'failed');
        // Revalidate the captured reference immediately before the host effect.
        if (!stillCurrent(expected)) { finish(); return; }
        setState('working');
        const result = await port.execute(request,controller.signal);
        if (!live || !stillCurrent(expected)) { finish(); return; }
        if (!equal(result?.identity,captured.identity) || result.operationId !== request.operationId || result.action !== action || !['completed','offline','forbidden','locked','failed'].includes(result.state)) throw Error('failed');
        finish(); setState(result.state);
      } catch (error) { if (live) { finish(); if (stillCurrent(expected)) setState(error instanceof Error && states.has(error.message as AttachmentState) ? error.message : 'failed'); } }
    }
    const contain = (event: Event) => event.stopPropagation();
    const events = ['beforeinput','input','keydown','keyup','compositionstart','compositionend','cut','paste','dragstart','dragover','drop','dragend'];
    for (const type of events) element.addEventListener(type,contain);
    const onCopy = (event: Event) => { event.stopPropagation(); const e = event as ClipboardEvent; if (!e.clipboardData) return; e.clipboardData.clearData(); e.clipboardData.setData('text/plain',event.target === source ? source.value.slice(source.selectionStart,source.selectionEnd) : data!.source); e.clipboardData.setData(ATTACHMENT_CLIPBOARD_MIME,JSON.stringify(attachmentClipboard(data!))); const fragment = JSON.stringify({version:1,schema:context.engine.read().identity.schema,blocks:[{attributes:{type:'content',tuple:['module:editac.asset',1,data]},runs:[{text:data!.fallback,marks:[]}]}]}); if (new TextEncoder().encode(fragment).length <= 1048576) e.clipboardData.setData(FRAGMENT_MIME,fragment); e.preventDefault(); };
    element.addEventListener('copy',onCopy);
    const update = (node: ContentContext['node']) => { const next = descriptor(node); if (disposed || !next) return false; const nextKey = JSON.stringify(next); current = node; if (key !== nextKey) { stop?.(); data = next; key = nextKey; present(); } else if (!stop) present(); return true; };
    update(context.node);
    return {element,update,setReadOnly(){},dispose(){ if (disposed) return; disposed = true; stop?.(); for (const b of buttons) { b.onclick = null; b.disabled = true; } copy.onclick = null; element.removeEventListener('copy',onCopy); for (const type of events) element.removeEventListener(type,contain); setState('disposed'); }};
  };
}
