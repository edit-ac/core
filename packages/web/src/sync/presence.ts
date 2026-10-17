import type { EngineHandle, PatchSubscription } from '@edit-ac/core';
import type { DOMSelection } from '../dom/selection.js';
import type { SyncTransport } from './session.js';
import { AwarenessAdapter, type AwarenessOptions, type PeerPresence } from './awareness.js';

export interface PresenceOptions extends AwarenessOptions {
  clientId: number;
  transport: SyncTransport;
  peerCarets?: boolean;
}
export interface PresenceAttachment {
  receive(frame: Uint8Array, now: number): void;
  pump(now: number): void;
  peers(now: number): readonly PeerPresence[];
}
/** Optional projection over the existing anchor-based awareness owner. The host
 * routes frames and drives monotonic time; this adapter creates no timer/socket. */
export class EditorPresence implements PresenceAttachment {
  readonly #awareness: AwarenessAdapter;
  readonly #subscription: PatchSubscription;
  readonly #layer: HTMLElement | undefined;
  #disposed = false;
  #now = 0;
  readonly #capture = () => {
    if (this.#disposed || this.root.ownerDocument.activeElement !== this.root) return;
    this.selection.capture(); this.#awareness.setLocal(this.selection.current?.range ?? null);
  };
  readonly #render = () => {
    if (!this.#layer || this.#disposed) return;
    this.#layer.replaceChildren();
    for (const peer of this.#awareness.peers(this.#now)) {
      if (!peer.selection || peer.selection.focus.type !== 'position') continue;
      const point = this.selection.toDOM(peer.selection.focus);
      if (!point) continue;
      const range = this.root.ownerDocument.createRange();
      range.setStart(point.node, point.offset); range.collapse(true);
      const rect = range.getBoundingClientRect();
      if (!rect.height) continue;
      const caret = this.root.ownerDocument.createElement('span');
      caret.dataset.peer = String(peer.clientId);
      caret.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;height:${rect.height}px;border-left:2px solid currentColor;pointer-events:none`;
      this.#layer.append(caret);
    }
  };
  constructor(readonly root: HTMLElement, readonly selection: DOMSelection, engine: EngineHandle, readonly options: PresenceOptions) {
    this.#awareness = new AwarenessAdapter(engine, options.clientId, options);
    if (options.peerCarets) {
      this.#layer = root.ownerDocument.createElement('div');
      this.#layer.setAttribute('aria-hidden', 'true'); this.#layer.dataset.editacPresence = '';
      root.after(this.#layer);
    }
    this.#subscription = engine.subscribe({ type: 'all' }, this.#render);
    root.ownerDocument.addEventListener('selectionchange', this.#capture);
    root.ownerDocument.addEventListener('scroll', this.#render, true);
    root.ownerDocument.defaultView?.addEventListener('resize', this.#render);
    this.#awareness.setLocal(null);
  }
  receive(frame: Uint8Array, now: number): void { if (this.#disposed) return; this.#awareness.receive(frame, now); this.#now = now; this.#render(); }
  pump(now: number): void { if (this.#disposed) return; this.#awareness.flush(bytes => this.options.transport.send(bytes), now); this.#now = now; this.#render(); }
  peers(now: number): readonly PeerPresence[] { return this.#disposed ? [] : this.#awareness.peers(now); }
  dispose(): void {
    if (this.#disposed) return; this.#disposed = true;
    this.root.ownerDocument.removeEventListener('selectionchange', this.#capture);
    this.root.ownerDocument.removeEventListener('scroll', this.#render, true);
    this.root.ownerDocument.defaultView?.removeEventListener('resize', this.#render);
    this.#subscription.dispose(); this.#awareness.dispose(); this.#layer?.remove();
  }
}
