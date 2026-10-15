import type { CommitResult, EngineHandle, PatchSubscription, PrepareRequest, ProjectedNode } from '@edit-ac/core';
import { admitLinkRequest, captureLinkRequest, linkIntentPermission, validateLinkResult } from './contract.js';
import type { EnrichmentPolicy, LinkHostContext, LinkHostPorts, LinkRequest, LinkOutcome } from './contract.js';

export interface LinkEnrichmentOptions {
  policy(): EnrichmentPolicy;
  context(): Readonly<LinkHostContext>;
  ports: Pick<LinkHostPorts, 'publicMetadata'>;
  /** Host changes (logout, session/permission/policy switch) invalidate display immediately. */
  subscribe(invalidate: () => void): () => void;
  /** Synchronous host asset-cache port: already vetted/decoded bounded raster
   * bytes under the host media/egress policy. No URL is loaded from metadata. */
  iconAsset?: (handle: string) => Blob | null;
  now?: () => number;
  /** Optional controller for explicit refresh/sharing; called once per surface. */
  attached?: (presenter: LinkEnrichment) => void;
}
export type LinkEnrichmentFactory = (root: HTMLElement, engine: EngineHandle, commit: (r: PrepareRequest) => CommitResult) => LinkEnrichment;
/** Hosts opt in explicitly; the default surface has no runtime presenter import. */
export function linkEnrichment(options: LinkEnrichmentOptions): LinkEnrichmentFactory {
  return (root, engine, commit) => {
    const presenter = new LinkEnrichment(root, engine, options, commit);
    try { options.attached?.(presenter); return presenter; }
    catch (error) { presenter.dispose(); throw error; }
  };
}
interface Ticket {
  request: Readonly<LinkRequest>; controller: AbortController; node: ProjectedNode;
  revision: number; from: number; to: number; fingerprint: string; view: HTMLElement;
  assetUrl?: string;
  outcome?: Extract<LinkOutcome, { status: 'available' }>; timer: ReturnType<typeof setTimeout>;
}
/** Optional surface-owned presenter. Network/auth/cache remain host responsibilities.
 * Preview never mutates the document; there is no document-open or edit scan. */
export class LinkEnrichment {
  readonly element: HTMLElement;
  #engine: EngineHandle; #options: LinkEnrichmentOptions; #commit: (r: PrepareRequest) => CommitResult;
  #tickets = new Map<string, Ticket>(); #subscription: PatchSubscription; #unsubscribe: () => void = () => {};
  #root: HTMLElement; #readonlyObserver: MutationObserver;
  #sequence = 0; #disposed = false; #readonly = false;
  constructor(root: HTMLElement, engine: EngineHandle, options: LinkEnrichmentOptions, commit: (r: PrepareRequest) => CommitResult) {
    this.#root = root;
    this.#readonlyObserver = new MutationObserver(() => {
      try {
        const readonly = this.#context().readonly;
        for (const t of this.#tickets.values()) if (t.request.host.readonly !== readonly) this.#remove(t);
      } catch { this.invalidate(); }
    });
    this.#readonlyObserver.observe(root, { attributes: true, attributeFilter: ['aria-readonly'] });
    this.#engine = engine; this.#options = options; this.#commit = commit;
    this.element = root.ownerDocument.createElement('aside');
    this.element.setAttribute('aria-label', 'Link metadata'); this.element.setAttribute('aria-live', 'polite');
    this.element.contentEditable = 'false'; root.after(this.element);
    this.#subscription = engine.subscribe({ type: 'all' }, patch => { if (patch.operation !== 'Selection') this.invalidate(); });
    try { this.#unsubscribe = options.subscribe(() => this.invalidate()); }
    catch (error) { this.#readonlyObserver.disconnect(); this.#subscription.dispose(); this.element.remove(); throw error; }
  }
  /** Decorate the existing local command port; only a successful clipboard
   * fragment origin may schedule automatic enrichment. History/remote bypass it. */
  readonly commit = (request: PrepareRequest): CommitResult => {
    if (this.#disposed) throw Error('Link presenter is disposed');
    const result = this.#commit(request);
    if (request.kind === 'fragment' && /^clipboard:[0-9]+$/u.test(request.origin)) {
      try { this.pasted(request, result); } catch { /* Observation cannot reject a committed paste. */ }
    }
    return result;
  };
  #now(): number { return (this.#options.now ?? Date.now)(); }
  #context(): Readonly<LinkHostContext> { const c = this.#options.context(); return { ...c, readonly: c.readonly || this.#readonly || this.#root.getAttribute('aria-readonly') === 'true' }; }
  #current(t: Ticket): Readonly<LinkRequest> | undefined {
    if (this.#disposed || t.controller.signal.aborted || !this.#tickets.has(t.request.requestId)) return;
    const s = this.#engine.read(); const node = s.visible.find(n => n.id === t.node.id);
    if (s.revision !== t.revision || s.identity.documentId !== t.request.host.scope.document || s.identity.epoch !== t.request.epoch
      || !node || JSON.stringify(node) !== t.fingerprint || this.#options.policy() !== t.request.policy) return;
    return { ...t.request, host: this.#context() };
  }
  #remove(t: Ticket): void {
    t.controller.abort(); clearTimeout(t.timer); if (t.assetUrl) URL.revokeObjectURL(t.assetUrl); t.view.remove(); this.#tickets.delete(t.request.requestId);
  }
  invalidate(): void { for (const t of this.#tickets.values()) this.#remove(t); }
  setReadOnly(value: boolean): void { this.#readonly = value; this.invalidate(); }
  /** Called only after the existing local clipboard command succeeds. */
  pasted(request: Extract<PrepareRequest, { kind: 'fragment' }>, result: CommitResult): void {
    if (this.#disposed || this.#readonly || this.#options.policy() !== 'local-paste') return;
    const urls = new Set(request.blocks.flatMap(b => b.runs.flatMap(r => r.marks.filter(m => m.mark === 'link').map(m => m.href))));
    if (!urls.size && request.blocks.length === 1) {
      const text = request.blocks[0]!.runs.map(r => r.text).join('');
      try { const u = new URL(text); if (['https:', 'http:'].includes(u.protocol)) urls.add(text); } catch {}
    }
    if (!urls.size) return;
    const s = this.#engine.read(); if (s.revision !== result.revision) return;
    for (const id of s.changedNodes) {
      const node = s.visible.find(n => n.id === id); if (node) this.#start(node, urls, 'local-paste');
    }
  }
  /** Explicit host/user action, never called by rendering, replay or history. */
  refresh(nodeId: string): void {
    if (this.#disposed) return;
    const node = this.#engine.read().visible.find(n => n.id === nodeId);
    if (node) this.#start(node, undefined, 'explicit-refresh');
  }
  #start(node: ProjectedNode, allowed: Set<string | null | undefined> | undefined, origin: 'local-paste' | 'explicit-refresh'): void {
    const s = this.#engine.read(); let offset = 0;
    for (const run of node.runs) {
      let from = offset; offset += run.text.length; let url = run.attributes.link; let to = offset;
      if (typeof url !== 'string' && allowed) {
        const plain = [...allowed].find(u => typeof u === 'string' && run.text.includes(u));
        if (plain) { url = plain; from += run.text.lastIndexOf(plain); to = from + plain.length; }
      }
      if (typeof url !== 'string' || (allowed && !allowed.has(url)) || this.#tickets.size >= 16) continue;
      // Shape admission here; full URL/DNS/connection admission belongs to host transport.
      let parsed: URL; try { parsed = new URL(url); } catch { continue; }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
      if ([...this.#tickets.values()].some(t => t.node.id === node.id && t.from === from && t.to === to)) continue;
      const host = this.#context(); if (origin === 'local-paste' && host.readonly) continue;
      if (host.scope.document !== s.identity.documentId) continue;
      const id = `link:${++this.#sequence}`;
      let request: Readonly<LinkRequest>;
      try { request = captureLinkRequest({ requestId: id, cancellationToken: id, node: node.id, epoch: s.identity.epoch,
        labelRevision: String(s.revision), host, target: { kind: 'public', url }, policy: this.#options.policy(), origin }); }
      catch { continue; }
      if (admitLinkRequest(request, host).status !== 'ready') continue;
      const view = this.element.ownerDocument.createElement('span'); view.setAttribute('role', 'status'); view.textContent = 'Loading link metadata';
      this.element.append(view);
      const controller = new AbortController();
      const t: Ticket = { request, controller, node, revision: s.revision, from, to, fingerprint: JSON.stringify(node), view,
        timer: setTimeout(() => this.#remove(t), 15_000) };
      this.#tickets.set(id, t);
      // Defer invocation until the initiating command/history boundary has finished.
      void Promise.resolve().then(async () => {
        try {
          const current = this.#current(t); if (!current || admitLinkRequest(request, current.host).status !== 'ready') { this.#remove(t); return; }
          const outcome = await this.#options.ports.publicMetadata(request, controller.signal);
          const latest = this.#current(t);
          if (!latest || validateLinkResult({ request, outcome }, latest, this.#now()) !== 'available' || outcome.status !== 'available') { this.#remove(t); return; }
          t.outcome = outcome; view.textContent = outcome.metadata.display.title;
          const handle = outcome.metadata.display.iconAsset;
          if (handle && latest.host.capabilities.icon && this.#options.iconAsset) {
            let blob: Blob | null = null;
            try { blob = this.#options.iconAsset(handle); } catch { /* Title fallback. */ }
            const currentIcon = this.#current(t);
            if (!currentIcon || validateLinkResult({ request, outcome }, currentIcon, this.#now()) !== 'available') { this.#remove(t); return; }
            if (blob instanceof Blob && blob.size > 0 && blob.size <= 32_768 && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(blob.type)) {
              t.assetUrl = URL.createObjectURL(blob);
              const icon = view.ownerDocument.createElement('img'); icon.src = t.assetUrl;
              icon.alt = ''; icon.setAttribute('aria-hidden', 'true'); icon.width = icon.height = 16; icon.decoding = 'async'; view.append(icon);
            }
          }
          // Opaque handles and advisory URLs never become remote browser requests.
          clearTimeout(t.timer); t.timer = setTimeout(() => this.#remove(t), Math.min(2_147_483_647, outcome.freshness.expiresAt - this.#now()));
        } catch { this.#remove(t); }
      });
    }
  }
  /** Deliberate disclosure into shared text; one explicit undo group. Host must
   * route commit through its normal authorization/persistence command port. */
  commitMetadata(requestId: string): boolean {
    const t = this.#tickets.get(requestId); if (!t?.outcome) return false;
    const current = this.#current(t);
    if (!current || linkIntentPermission(t.request, current.host, 'commit-metadata') !== 'available'
      || validateLinkResult({ request: t.request, outcome: t.outcome }, current, this.#now()) !== 'available') { this.#remove(t); return false; }
    const title = t.outcome.metadata.display.title, target = t.request.target;
    if (target.kind !== 'public') return false;
    const request: PrepareRequest = { kind: 'editor', origin: 'link:commit-metadata', commands: [
      { type: 'replaceAt', owner: t.node.id, from: t.from, to: t.to, text: title },
      { type: 'markAt', owner: t.node.id, from: t.from, to: t.from + title.length, mark: 'link', action: 'apply', href: target.url },
    ] };
    if (!this.#engine.can(request)) return false;
    this.#engine.history({ type: 'explicit' });
    try { this.#commit(request); return true; } finally { this.#engine.history({ type: 'boundary' }); }
  }
  dispose(): void {
    if (this.#disposed) return; this.#disposed = true;
    this.invalidate(); this.#readonlyObserver.disconnect(); this.#subscription.dispose(); try { this.#unsubscribe(); } finally { this.element.remove(); }
  }
}
