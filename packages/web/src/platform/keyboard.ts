import type { ViewportGeometry } from './viewport.js';
import { type CapabilityResult, fallback } from './capabilities.js';
const overlays = new WeakMap<object, { previous: boolean; owners: Set<KeyboardAdapter> }>();
const locks = new WeakMap<object, KeyboardAdapter>();
const result = (outcome: CapabilityResult['outcome']): CapabilityResult => ({ outcome, fallback });
/** Platform presentation only. Never changes semantic keys, content, selection or history. */
export class KeyboardAdapter {
  private disposed = false;
  private generation = 0;
  private layout: Map<string, string> | undefined;
  private layoutSource: any;
  private geometrySource: any;
  private overlaySource: any;
  private lockSource: any;
  private lockPending = false;
  private lockCanceled = false;
  private lockRelease: (() => void) | undefined;
  private releases: (() => void)[] = [];
  private readonly window: Window;
  constructor(readonly root: HTMLElement, private readonly invalidate: () => void) {
    this.window = root.ownerDocument.defaultView!;
    const cancel = () => this.cancel();
    const hidden = () => { if (root.ownerDocument.visibilityState === 'hidden') cancel(); };
    const fullscreen = () => { if (!root.ownerDocument.fullscreenElement) cancel(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    for (const [target, name, handler] of [[this.window,'blur',cancel],[this.window,'pagehide',cancel],
      [root,'blur',cancel],[root,'keydown',escape],[root.ownerDocument,'visibilitychange',hidden],
      [root.ownerDocument,'fullscreenchange',fullscreen]] as const) {
      target.addEventListener(name, handler as EventListener);
      this.releases.push(() => target.removeEventListener(name, handler as EventListener));
    }
  }
  private api(name: string): any {
    try { return this.window.isSecureContext ? (this.window.navigator as any)[name] : undefined; } catch { return undefined; }
  }
  private active(): boolean {
    try { return !this.disposed && this.root.isConnected && !!this.window.navigator.userActivation?.isActive; } catch { return false; }
  }
  label(code: string, defaultLabel: string): string { return this.layoutSource === this.api('keyboard') ? this.layout?.get(code) ?? defaultLabel : defaultLabel; }
  private readonly layoutChanged = (): void => { this.generation++; this.layout = undefined; };
  async refreshLayout(): Promise<CapabilityResult> {
    if (this.disposed) return result('canceled');
    const api = this.api('keyboard'), generation = ++this.generation;
    try {
      if (typeof api?.getLayoutMap !== 'function') { this.layoutChanged(); this.detachLayout(); return result('unavailable'); }
      if (this.layoutSource !== api) { this.detachLayout(); this.layoutSource = api; api.addEventListener('layoutchange', this.layoutChanged); }
      const map = await api.getLayoutMap();
      if (this.disposed || generation !== this.generation || this.api('keyboard') !== api) return result('canceled');
      this.layout = new Map<string, string>();
      // Bound both work and retained labels; hostile/invalid values keep ordinary labels.
      let count = 0;
      for (const [code, label] of map) {
        if (++count > 256) break;
        if (typeof code === 'string' && code.length <= 64 && typeof label === 'string' && label.length <= 32) this.layout.set(code, label);
      }
      return result('applied');
    } catch { this.layout = undefined; return result(this.disposed ? 'canceled' : 'denied'); }
  }
  private detachLayout(): void { try { this.layoutSource?.removeEventListener('layoutchange', this.layoutChanged); } catch {} this.layoutSource = undefined; }
  private readonly geometryChanged = (): void => this.invalidate();
  observeGeometry(): CapabilityResult {
    if (this.disposed) return result('canceled');
    this.detachGeometry();
    const api = this.api('virtualKeyboard');
    try {
      if (typeof api?.addEventListener !== 'function') return result('unavailable');
      api.addEventListener('geometrychange', this.geometryChanged); this.geometrySource = api;
      this.invalidate(); return result('applied');
    } catch { return result('denied'); }
  }
  private detachGeometry(): void { try { this.geometrySource?.removeEventListener('geometrychange', this.geometryChanged); } catch {} this.geometrySource = undefined; }
  geometry(): ViewportGeometry {
    let v: VisualViewport | null = null;
    try { v = this.window.visualViewport; } catch { /* ordinary layout fallback */ }
    const geometry: ViewportGeometry = { visual: { left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0, width: v?.width ?? this.window.innerWidth, height: v?.height ?? this.window.innerHeight }, scale: v?.scale ?? 1 };
    try {
      const api = this.api('virtualKeyboard'), r = api?.boundingRect;
      if (!this.disposed && api === this.geometrySource && api === this.overlaySource && api.overlaysContent === true && r &&
        [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width > 0 && r.height > 0) geometry.occlusions = [{ left:r.x, top:r.y, width:r.width, height:r.height }];
    } catch { /* ordinary viewport fallback */ }
    return geometry;
  }
  leaseOverlay(): CapabilityResult {
    if (this.disposed) return result('canceled');
    const api = this.api('virtualKeyboard');
    if (api === this.overlaySource && api) return result('applied');
    this.releaseOverlay();
    try {
      if (!api || typeof api.overlaysContent !== 'boolean') return result('unavailable');
      let lease = overlays.get(api);
      if (!lease) { const previous = api.overlaysContent; api.overlaysContent = true; if (api.overlaysContent !== true) return result('denied'); lease = { previous, owners:new Set() }; overlays.set(api,lease); }
      lease.owners.add(this); this.overlaySource = api; this.invalidate(); return result('applied');
    } catch { return result('denied'); }
  }
  releaseOverlay(): void {
    const api = this.overlaySource; this.overlaySource = undefined;
    if (!api) return;
    const lease = overlays.get(api); if (!lease) return;
    lease.owners.delete(this);
    if (!lease.owners.size) { overlays.delete(api); try { if (api.overlaysContent === true) api.overlaysContent = lease.previous; } catch {} }
    this.invalidate();
  }
  requestVisibility(action: 'show' | 'hide'): CapabilityResult {
    if (this.disposed) return result('canceled');
    if (!this.active() || this.root.ownerDocument.activeElement !== this.root) return result('denied');
    const api = this.api('virtualKeyboard');
    try { if (typeof api?.[action] !== 'function') return result('unavailable'); api[action](); return result('applied'); } catch { return result('denied'); }
  }
  /** Kiosk only. A visible, host-owned escape control is mandatory. No default editor lock. */
  async requestLock(keys: readonly string[], escapeControl: HTMLElement): Promise<CapabilityResult> {
    if (this.disposed) return result('canceled');
    const doc = this.root.ownerDocument, api = this.api('keyboard');
    if (!this.active() || doc.activeElement !== this.root || !doc.fullscreenElement?.contains(this.root) || !doc.fullscreenElement.contains(escapeControl) || !escapeControl.isConnected || escapeControl.ownerDocument !== doc ||
      escapeControl.getBoundingClientRect().width <= 0 || escapeControl.getBoundingClientRect().height <= 0 || escapeControl.matches(':disabled') || escapeControl.tabIndex < 0 || escapeControl.getAttribute('aria-hidden') === 'true' || keys.length > 64 || keys.includes('Escape')) return result('denied');
    try {
      if (typeof api?.lock !== 'function' || typeof api?.unlock !== 'function') return result('unavailable');
      if (this.lockSource || locks.has(api)) return result('denied');
      locks.set(api,this); this.lockSource = api; this.lockPending = true; this.lockCanceled = false;
      const cancel = () => this.cancel(); escapeControl.addEventListener('click',cancel);
      this.lockRelease = () => escapeControl.removeEventListener('click',cancel);
      await api.lock([...keys]);
      this.lockPending = false;
      if (this.disposed || this.lockCanceled || this.lockSource !== api) { this.releaseLock(); return result('canceled'); }
      return result('applied');
    } catch { this.lockPending = false; this.releaseLock(); return result(this.disposed ? 'canceled' : 'denied'); }
  }
  private releaseLock(): void {
    this.lockCanceled = true; this.lockRelease?.(); this.lockRelease = undefined;
    const api = this.lockSource;
    if (api && locks.get(api) === this) {
      // Retain the reservation until a pending request settles; a late grant cannot
      // unlock or replace another editor's lock. No new request may race it.
      if (!this.lockPending) { locks.delete(api); this.lockSource = undefined; }
      try { api.unlock(); } catch {}
    }
  }
  cancel(): void { this.generation++;this.layout=undefined;this.releaseLock();this.releaseOverlay(); }
  dispose(): void { if(this.disposed)return;this.disposed=true;this.cancel();this.detachLayout();this.detachGeometry();for(const release of this.releases)release();this.releases=[]; }
}
