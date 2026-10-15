import type { ProjectedNode } from '@edit-ac/core';
import type { ContentContext, ContentFactory, ContentView } from '../content.js';
import { admitLinkRequest, captureLinkRequest, validateLinkResult } from '../links/contract.js';
import type { LinkHostContext, LinkHostPorts, LinkRequest, LinkResult, LinkState } from '../links/contract.js';

export interface PrivateReferenceDisplayOptions {
  context(): Readonly<LinkHostContext>;
  /** Configured catalog parses identity/authority; never derive authority from metadata. */
  target(targetId: string): { targetId: string; authority: string | null } | undefined;
  /** Local-only host cache port, keyed by the complete viewer/target/policy envelope.
   * No IO, credential loading, or automatic resolution is permitted here. */
  cached(request: Readonly<LinkRequest>): Readonly<LinkResult> | undefined;
  ports: Pick<LinkHostPorts, 'privateCatalog'>;
  /** Includes logout, account/tenant/authority/policy changes, lock/revoke and lease expiry. */
  subscribe(invalidate: () => void): () => void;
  /** Already vetted, bounded raster bytes from the host cache; never a remote URL. */
  iconAsset?: (handle: string) => Blob | null;
  now?: () => number;
}
interface Reference { targetId: string; label: string }
function reference(node: ProjectedNode): Reference | undefined {
  const tuple = node.blockAttributes;
  if (!Array.isArray(tuple) || tuple[0] !== 'module:editac.reference' || tuple[1] !== 1 || tuple.length !== 3) return;
  const data = tuple[2];
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'label,targetId') return;
  const { targetId, label } = data;
  if (![targetId, label].every(s => typeof s === 'string' && s.length > 0 && s.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(s))) return;
  return { targetId: targetId as string, label: label as string };
}
/** Compose with existing contentModules via referenceFactory(ctx) ?? otherFactory(ctx).
 * Render reads only the host's scoped cache; the refresh button is the sole IO origin. */
export function privateReferenceDisplay(options: PrivateReferenceDisplayOptions): ContentFactory {
  return context => reference(context.node) ? new PrivateReferenceView(context, options) : undefined;
}
let sequence = 0;
export class PrivateReferenceView implements ContentView {
  readonly element: HTMLElement;
  private node: ProjectedNode;
  private readonly label: HTMLElement;
  private readonly title: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly status: HTMLElement;
  private readonly refresh: HTMLButtonElement;
  private image: HTMLImageElement | undefined;
  private assetUrl: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: AbortController | undefined;
  private unsubscribe: () => void = () => {};
  private disposed = false;
  private generation = 0;
  private nodeRevision = 0;
  private readOnly: boolean;
  constructor(private readonly context: ContentContext, private readonly options: PrivateReferenceDisplayOptions) {
    this.node = context.node; this.readOnly = context.readOnly;
    const doc = context.element.ownerDocument;
    this.element = doc.createElement('section'); this.element.dataset.privateReference = ''; this.element.contentEditable = 'false';
    this.label = doc.createElement('span'); this.label.dataset.referenceLabel = '';
    this.title = doc.createElement('span'); this.title.dataset.privateTitle = '';
    this.preview = doc.createElement('span'); this.preview.dataset.privatePreview = '';
    this.status = doc.createElement('span'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.refresh = doc.createElement('button'); this.refresh.type = 'button'; this.refresh.textContent = 'Refresh reference';
    this.refresh.addEventListener('click', this.refreshClicked);
    this.element.append(this.label, this.title, this.preview, this.status, this.refresh);
    try {
      this.unsubscribe = options.subscribe(() => this.invalidate());
      if (typeof this.unsubscribe !== 'function') throw Error('Invalid private reference subscription');
      this.invalidate();
    } catch (error) { this.dispose(); throw error; }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private request(origin: 'render' | 'explicit-refresh', id: string): Readonly<LinkRequest> {
    const data = reference(this.node);
    if (!data) throw Error('Invalid reference');
    const target = this.options.target(data.targetId), host = this.options.context(), snapshot = this.context.engine.read();
    if (!target || target.targetId !== data.targetId) throw Error('Reference unavailable');
    return captureLinkRequest({ requestId: id, cancellationToken: id, node: this.node.id, epoch: snapshot.identity.epoch,
      labelRevision: String(this.nodeRevision), host: { ...host, readonly: this.readOnly || host.readonly },
      target: { kind: 'private', ...target }, policy: 'explicit-refresh', origin });
  }
  private check(result: Readonly<LinkResult>, request: Readonly<LinkRequest>): LinkState {
    if (result.request.origin !== request.origin || result.outcome.status === 'available' && result.outcome.metadata.kind !== 'private') return 'unsupported';
    // Cache display is not lookup admission. Reuse the complete result/authority validator
    // with an enabled envelope without invoking either network port on render.
    return validateLinkResult({ ...result, request: { ...result.request, origin: 'explicit-refresh' } },
      { ...request, origin: 'explicit-refresh' }, this.now(), this.disposed);
  }
  private clear(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.title.textContent = ''; this.preview.textContent = ''; this.image?.remove(); this.image = undefined;
    if (this.assetUrl) URL.revokeObjectURL(this.assetUrl); this.assetUrl = undefined;
  }
  cancel(): void {
    ++this.generation; this.pending?.abort(); this.pending = undefined;
    this.fallback('canceled'); this.element.removeAttribute('aria-busy');
  }
  private fallback(state: LinkState = 'unavailable'): void {
    this.clear(); this.label.textContent = reference(this.node)?.label ?? 'Reference';
    // Missing/forbidden have the same non-disclosing presentation.
    this.status.textContent = ({ available: 'Reference available', unavailable: 'Reference unavailable', forbidden: 'Reference unavailable', missing: 'Reference unavailable',
      locked: 'Reference locked', unsupported: 'Reference unsupported', canceled: 'Reference canceled', stale: 'Reference expired' })[state];
    this.element.dataset.state = state === 'forbidden' || state === 'missing' ? 'unavailable' : state;
    this.element.setAttribute('aria-label', this.label.textContent + '. ' + this.status.textContent);
  }
  private display(result: Readonly<LinkResult>, request: Readonly<LinkRequest>): void {
    const generation = this.generation;
    let state = this.check(result, request);
    if (state !== 'available' || result.outcome.status !== 'available') { this.fallback(state); return; }
    const outcome = result.outcome, display = outcome.metadata.display;
    let blob: Blob | null = null;
    try { if (display.iconAsset) blob = this.options.iconAsset?.(display.iconAsset) ?? null; } catch { /* Safe title fallback. */ }
    // All host callbacks may synchronously revoke/switch/dispose this viewer.
    state = this.check(result, this.request(request.origin as 'render' | 'explicit-refresh', request.requestId));
    if (this.disposed || generation !== this.generation) return;
    if (state !== 'available') { this.fallback(state); return; }
    this.fallback('available'); this.title.textContent = display.title; this.preview.textContent = display.description ?? '';
    if (blob instanceof Blob && blob.size > 0 && blob.size <= 32768 && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(blob.type)) {
      this.assetUrl = URL.createObjectURL(blob); this.image = this.element.ownerDocument.createElement('img');
      this.image.alt = ''; this.image.setAttribute('aria-hidden', 'true'); this.image.src = this.assetUrl; this.element.prepend(this.image);
    }
    this.element.setAttribute('aria-label', this.label.textContent + '. ' + display.title + '. Reference available');
    this.timer = setTimeout(() => this.invalidate(), Math.min(2147483647, Math.max(1, outcome.freshness.expiresAt - this.now())));
  }
  invalidate(): void {
    if (this.disposed) return;
    this.cancel(); this.fallback();
    try {
      const request = this.request('render', `view-${++sequence}`), generation = this.generation;
      const result = this.options.cached(request);
      if (!this.disposed && generation === this.generation && result) this.display(result, this.request('render', request.requestId));
    } catch { if (!this.disposed) this.fallback(); }
  }
  private refreshClicked = (): void => { void this.resolve(); };
  private async resolve(): Promise<void> {
    if (this.disposed) return;
    this.cancel(); this.fallback();
    const controller = new AbortController(); this.pending = controller;
    const generation = this.generation;
    try {
      const request = this.request('explicit-refresh', `refresh-${++sequence}`);
      const admission = admitLinkRequest(request, request.host);
      if (admission.status !== 'ready') { this.fallback(admission.status); return; }
      this.status.textContent = 'Refreshing reference'; this.element.setAttribute('aria-busy', 'true');
      this.timer = setTimeout(() => { if (this.pending === controller) { this.cancel(); this.fallback(); this.element.removeAttribute('aria-busy'); } }, 10000);
      const outcome = await this.options.ports.privateCatalog(request, controller.signal);
      if (controller.signal.aborted || this.disposed || generation !== this.generation) return;
      this.display({ request, outcome }, this.request('explicit-refresh', request.requestId));
    } catch { if (!this.disposed && generation === this.generation) this.fallback(); }
    finally {
      if (this.pending === controller) { this.pending = undefined; this.element.removeAttribute('aria-busy'); }
    }
  }
  update(node: ProjectedNode): boolean {
    if (!reference(node)) return false;
    this.node = node; ++this.nodeRevision; this.invalidate(); return true;
  }
  setReadOnly(value: boolean): void { this.readOnly = value; this.invalidate(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.cancel(); this.refresh.removeEventListener('click', this.refreshClicked);
    try { this.unsubscribe(); } finally { this.fallback(); this.element.removeAttribute('aria-busy'); }
  }
}
