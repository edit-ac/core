import type { EditorViewport, ViewportGeometry } from './viewport.js';
import { KeyboardAdapter } from './keyboard.js';

export type CapabilityResult = { outcome: 'applied' | 'unavailable' | 'denied' | 'canceled'; fallback: string; value?: unknown };
export const fallback = 'Use native editing, Paste, file input or an explicit copy/download control.';
/** Optional, loaded only by BrowserEditor.enableBrowserCapabilities(). No mount-time API requests. */
export class BrowserCapabilities {
  readonly keyboard: KeyboardAdapter;
  private disposed = false;
  private fullscreenOwned = false;
  private releaseOcclusion: (() => void) | undefined;
  constructor(readonly root: HTMLElement, viewport?: EditorViewport) {
    this.keyboard = new KeyboardAdapter(root, () => viewport?.invalidate());
    this.releaseOcclusion = viewport?.addOcclusionSource(() => this.keyboard.geometry().occlusions?.[0]);
  }
  geometry(): ViewportGeometry { return this.keyboard.geometry(); }
  /** Host actions must originate in an explicit activation. API presence is not authorization. */
  async request(action: 'share' | 'file' | 'fullscreen' | 'orientation', data?: ShareData): Promise<CapabilityResult> {
    if (this.disposed) return { outcome: 'canceled', fallback };
    const w = this.root.ownerDocument.defaultView!, n = w.navigator as any;
    try {
      if (!w.isSecureContext || !n.userActivation?.isActive) return { outcome: 'denied', fallback };
      let result: unknown;
      if (action === 'share') {
        if (typeof n.share !== 'function' || typeof n.canShare !== 'function' || !n.canShare(data ?? {})) return { outcome: 'unavailable', fallback };
        result = n.share(data);
      } else if (action === 'file') {
        if (typeof (w as any).showOpenFilePicker !== 'function') return { outcome: 'unavailable', fallback };
        result = (w as any).showOpenFilePicker();
      } else if (action === 'fullscreen') {
        if (typeof this.root.requestFullscreen !== 'function') return { outcome: 'unavailable', fallback };
        if (this.root.ownerDocument.fullscreenElement === this.root) return { outcome: 'applied', fallback };
        result = this.root.requestFullscreen();
      } else {
        // Orientation locking is host policy, outside the editor's ownership.
        return { outcome: 'unavailable', fallback: 'Allow ordinary rotation and reflow.' };
      }
      const value = await result;
      if (action === 'fullscreen') this.fullscreenOwned = this.root.ownerDocument.fullscreenElement === this.root;
      if (action === 'fullscreen' && this.disposed) await this.releaseFullscreen();
      return { value, outcome: this.disposed ? 'canceled' : 'applied', fallback };
    } catch { return { outcome: this.disposed ? 'canceled' : 'denied', fallback }; }
  }
  private async releaseFullscreen(): Promise<void> {
    try { if (this.fullscreenOwned && this.root.ownerDocument.fullscreenElement === this.root) await this.root.ownerDocument.exitFullscreen(); } catch { /* host fallback */ }
  }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.releaseOcclusion?.(); this.keyboard.dispose();
      void this.releaseFullscreen(); } }
}
