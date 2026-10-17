import { admitLinkRequest, captureLinkRequest, linkIntentPermission, safeLink, validateLinkResult } from '@edit-ac/core';
import type { LinkHostContext, LinkHostPorts, LinkRequest, LinkOutcome } from '@edit-ac/core';
import type { ContentContext, ContentFactory } from '../content.js';

/** Opaque source-preserving module tuple, not executable provider markup. */
export interface EmbedDescriptor { url: string; provider: string; fallback: string; source: string }
export interface EmbedTemplate {
  provider: string;
  /** Host-configured HTTPS endpoint, with no query/fragment/credentials. The original
   * locator is encoded as the sole `url` query parameter. Never supplied by metadata. */
  endpoint: string;
}
export interface EmbedOptions {
  embeds?: {
    resolver: Pick<LinkHostPorts, 'publicMetadata'>;
    /** Current authenticated host scope, not document-supplied identity. */
    context(): Readonly<LinkHostContext>;
    templates: readonly EmbedTemplate[];
    timeoutMs?: number; concurrency?: number;
  };
}
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
function descriptor(node: ContentContext['node']): EmbedDescriptor | undefined {
  const t = node.blockAttributes;
  if (!Array.isArray(t) || t.length !== 3 || t[0] !== 'module:editac.inert-extension' || t[1] !== 1 || !t[2] || typeof t[2] !== 'object' || Array.isArray(t[2])) return;
  const envelope = t[2] as unknown as { type: string; version: number; dataVersion: number; source: string; payload: Omit<EmbedDescriptor,'source'> };
  if (envelope.type !== 'editac.embed' || envelope.version !== 1 || envelope.dataVersion !== 1 || !envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload) || Object.keys(envelope).sort().join(',') !== 'dataVersion,payload,source,type,version') return;
  const d = {...envelope.payload,source:envelope.source};
  if (Object.keys(d).sort().join(',') !== 'fallback,provider,source,url' || !text(d.url,4096) || !text(d.provider,64) || !/^[a-zA-Z0-9_.-]+$/u.test(d.provider) || !text(d.fallback,8192) || typeof d.source !== 'string' || new TextEncoder().encode(d.source).length > 1048576) return;
  return {...d};
}
const publicUrl = (value: string) => safeLink(value) !== null && new URL(value).protocol === 'https:';
/** Inert metadata by default; all optional work is explicit, ephemeral and bounded. */
export function embedPresenters(options: EmbedOptions = {}): ContentFactory {
  const host = options.embeds, templates = new Map<string,string>();
  const timeoutMs = host?.timeoutMs ?? 15000, concurrency = host?.concurrency ?? 8;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw Error('Invalid embed limit');
  if (host) {
    if (typeof host.context !== 'function' || typeof host.resolver?.publicMetadata !== 'function' || !Array.isArray(host.templates) || host.templates.length > 32) throw Error('Invalid embed host');
    for (const t of host.templates) {
      if (!text(t.provider,64) || !/^[a-zA-Z0-9_.-]+$/u.test(t.provider) || templates.has(t.provider) || !publicUrl(t.endpoint)) throw Error('Invalid embed template');
      const url = new URL(t.endpoint);
      if (url.search || url.hash || url.port) throw Error('Invalid embed endpoint');
      templates.set(t.provider,url.href);
    }
  }
  let active = 0;
  return context => {
    let data = descriptor(context.node); if (!data) return;
    const doc = context.element.ownerDocument, element = doc.createElement('section'), label = doc.createElement('strong'), description = doc.createElement('p'), status = doc.createElement('span'), source = doc.createElement('textarea');
    const refresh = doc.createElement('button'), activate = doc.createElement('button'), deactivate = doc.createElement('button');
    element.dataset.contentModule = 'embed'; element.contentEditable = 'false'; status.setAttribute('role','status'); source.readOnly = true; source.setAttribute('aria-label','Embed source');
    refresh.textContent = 'Refresh card'; activate.textContent = 'Activate embed'; deactivate.textContent = 'Deactivate embed';
    for (const b of [refresh,activate,deactivate]) b.type = 'button';
    element.append(label,description,status,source,refresh,activate,deactivate);
    let disposed = false, readOnly = context.readOnly, current = context.node, key = '', stop: (() => void) | undefined, frame: HTMLIFrameElement | undefined;
    const state = (value: string) => { element.dataset.embedState = value; status.textContent = `Embed ${value}.`; };
    const clearFrame = () => { frame?.removeAttribute('src'); frame?.remove(); frame = undefined; deactivate.disabled = true; };
    const fallback = () => { label.textContent = data!.fallback; description.textContent = data!.url; source.value = data!.source; };
    const buttons = () => { refresh.disabled = !host || readOnly || !!stop || disposed; activate.disabled = refresh.disabled || !templates.has(data!.provider); deactivate.disabled = !frame; };
    const present = () => { fallback(); state(host && templates.has(data!.provider) ? 'inactive' : 'unsupported'); buttons(); };
    const liveNode = (expected: string) => !disposed && element.isConnected && expected === key && JSON.stringify(context.engine.read().visible.find(n => n.id === current.id)?.blockAttributes) === JSON.stringify(current.blockAttributes);
    async function run(interactive: boolean): Promise<void> {
      if (!host || readOnly || disposed || stop || !liveNode(key)) return;
      if (!publicUrl(data!.url)) { state('unsupported'); return; }
      if (interactive && !templates.has(data!.provider)) { state('unsupported'); return; }
      if (active >= concurrency) { state('busy'); return; }
      clearFrame(); fallback();
      const expected = key, captured = data!;
      let request: Readonly<LinkRequest>;
      try {
        request = captureLinkRequest({requestId:crypto.randomUUID(),cancellationToken:crypto.randomUUID(),node:current.id,epoch:context.engine.read().identity.epoch,labelRevision:crypto.randomUUID(),host:host.context(),target:{kind:'public',url:captured.url},policy:'explicit-refresh',origin:'explicit-refresh'});
        if (request.host.readonly) { state('forbidden'); return; }
        const admission = admitLinkRequest(request,host.context());
        if (admission.status !== 'ready') { state(admission.status); return; }
        if (interactive && linkIntentPermission(request,host.context(),'activate') !== 'available') { state('forbidden'); return; }
      } catch { state('unsupported'); return; }
      const controller = new AbortController(); let pending = true; active++;
      const finish = () => { if (!pending) return; pending = false; clearTimeout(timer); controller.abort(); active--; stop = undefined; buttons(); };
      const timer = setTimeout(() => { finish(); if (liveNode(expected)) { fallback(); state('timeout'); } },timeoutMs);
      stop = finish; buttons(); state('loading');
      try {
        const outcome: LinkOutcome = await host.resolver.publicMetadata(request,controller.signal);
        if (!pending || !liveNode(expected)) { finish(); return; }
        const now = Date.now(), currentRequest = {...request,host:host.context()};
        const validated = validateLinkResult({request,outcome},currentRequest,now);
        if (validated !== 'available' || outcome.status !== 'available') { finish(); fallback(); state(validated); return; }
        if (outcome.metadata.kind !== 'public' || outcome.metadata.provider !== captured.provider) { finish(); state('unsupported'); return; }
        if (interactive && (readOnly || host.context().readonly || linkIntentPermission(request,host.context(),'activate') !== 'available')) { finish(); fallback(); state('forbidden'); return; }
        if (!pending || !liveNode(expected)) { finish(); return; }
        // Only text fields are projected. Provider HTML/canonical/media URLs are never used.
        label.textContent = outcome.metadata.display.title; description.textContent = outcome.metadata.display.description ?? captured.url;
        if (interactive) {
          const endpoint = new URL(templates.get(captured.provider)!); endpoint.searchParams.set('url',captured.url);
          frame = doc.createElement('iframe'); frame.title = captured.fallback; frame.setAttribute('sandbox','allow-scripts'); frame.referrerPolicy = 'no-referrer'; frame.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'"); frame.setAttribute('credentialless',''); frame.src = endpoint.href; element.append(frame);
        }
        finish(); state(interactive ? 'active' : 'card'); buttons();
      } catch { if (pending) { finish(); if (liveNode(expected)) { fallback(); state('unavailable'); } } }
    }
    refresh.onclick = () => { void run(false); }; activate.onclick = () => { void run(true); };
    deactivate.onclick = () => { clearFrame(); fallback(); state('inactive'); buttons(); };
    const contain = (event: Event) => event.stopPropagation();
    const events = ['beforeinput','input','keydown','keyup','compositionstart','compositionend','cut','paste','dragstart','dragover','drop','dragend'];
    for (const type of events) element.addEventListener(type,contain);
    const update = (node: ContentContext['node']) => { const next = descriptor(node); if (disposed || !next) return false; current = node; const nextKey = JSON.stringify(next); if (nextKey !== key) { stop?.(); clearFrame(); data = next; key = nextKey; present(); } else if (host) { try { if (!host.context().scope.authorized) { stop?.(); clearFrame(); fallback(); state('forbidden'); buttons(); } } catch { stop?.(); clearFrame(); fallback(); state('unavailable'); buttons(); } } return true; };
    update(context.node);
    return {element,update,setReadOnly(value){ readOnly = value; if (value) { stop?.(); clearFrame(); fallback(); state('inactive'); } buttons(); },dispose(){ if (disposed) return; disposed = true; stop?.(); clearFrame(); for (const b of [refresh,activate,deactivate]) b.onclick = null; for (const type of events) element.removeEventListener(type,contain); state('disposed'); buttons(); }};
  };
}
