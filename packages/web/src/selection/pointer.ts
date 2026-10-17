import type { DOMSelection, ModelPoint, RetainedSelection } from '../dom/selection.js';

/** Host geometry can reveal an unmounted endpoint. It must return an existing
 * logical point; the bridge validates it against the real renderer before use. */
export interface PointerSelectionViewport {
  hitTest(x: number, y: number): ModelPoint | undefined;
  reveal(point: ModelPoint): void;
}
interface Gesture { id: number; x: number; y: number; startX: number; startY: number; source: RetainedSelection | undefined; textDrag: boolean; moved: boolean }
/** Native granularity/drag arbitration stays with the browser. The optional host
 * viewport supplies only geometry, never content edits or semantic selections. */
export class PointerSelection {
  viewport: PointerSelectionViewport | undefined;
  #gesture: Gesture | undefined;
  #context: RetainedSelection | undefined;
  #focusOwner: { pointerId: number; element: HTMLElement } | undefined;
  #frame: number | undefined;
  #disposed = false;
  #listeners: (() => void)[] = [];
  #work = { frames: 0, hitTests: 0, scrollWrites: 0 };
  constructor(readonly selection: DOMSelection) {
    const root = selection.renderer.root, doc = root.ownerDocument, view = doc.defaultView!;
    this.#listen(root, 'pointerdown', event => {
      const e = event as PointerEvent;
      this.#focusOwner = undefined;
      if (!this.#owns(e.target) || selection.suspended) return;
      this.dismissContext(); this.cancel();
      if (e.button === 2) { this.#context = selection.retain(); return; }
      if (e.button !== 0 || !e.isPrimary || e.pointerType !== 'mouse') return;
      const native = doc.getSelection(), source = selection.retain();
      // Do not collapse selected text on press or start selection autoscroll
      // when the platform may be arbitrating a selected-text drag.
      const hit = this.#hit(e.clientX, e.clientY);
      const range = native?.rangeCount ? native.getRangeAt(0) : undefined;
      const textDrag = !!(source && native && !native.isCollapsed && hit && range?.isPointInRange(hit.node, hit.offset));
      this.#gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, source, textDrag, moved: false };
    });
    this.#listen(doc, 'pointermove', event => {
      const e = event as PointerEvent, p = this.#gesture;
      if (this.#focusOwner?.pointerId === e.pointerId && !(e.buttons & 1)) this.#focusOwner = undefined;
      if (!p || p.id !== e.pointerId) return;
      if (!(e.buttons & 1)) { this.cancel(); return; }
      p.x = e.clientX; p.y = e.clientY;
      const wasMoved = p.moved;
      p.moved ||= Math.hypot(p.x - p.startX, p.y - p.startY) >= 4;
      if (!wasMoved && p.moved && !p.textDrag) { p.source?.dispose(); p.source = selection.retain(); }
      // The native platform decides drag threshold and word/paragraph granularity.
      // Adapter geometry work is only needed for an explicitly virtualized host.
      if (p.moved && p.textDrag) this.#preserveDragSource();
      if (p.moved && !p.textDrag && this.viewport) this.#schedule();
    });
    this.#listen(root, 'mousedown', event => {
      // Repeated clicks start native word/paragraph extension, not a text drag.
      if (this.#gesture && (event as MouseEvent).detail > 1) this.#gesture.textDrag = false;
    });
    this.#listen(root, 'selectstart', event => {
      if (this.#gesture?.textDrag && this.#gesture.moved) event.preventDefault();
    });
    this.#listen(doc, 'selectionchange', () => this.#preserveDragSource());
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) this.#listen(doc, type, event => {
      if (this.#gesture?.id === (event as PointerEvent).pointerId) this.cancel();
      if (this.#focusOwner?.pointerId === (event as PointerEvent).pointerId) this.#focusOwner = undefined;
    });
    this.#listen(root, 'blur', event => {
      const p = this.#gesture, next = (event as FocusEvent).relatedTarget as HTMLElement | null;
      this.cancel();
      // WebKit's native selection autoscroll can request editor focus again
      // while the original mouse button is held. Preserve the explicit new
      // focus owner only until that pointer ends or a new press begins.
      if (p?.moved && !p.textDrag && this.viewport && next?.isConnected && !root.contains(next) && typeof next.focus === 'function')
        this.#focusOwner = { pointerId: p.id, element: next };
    });
    this.#listen(root, 'focus', () => {
      const next = this.#focusOwner?.element;
      if (!this.#disposed && next?.isConnected && doc.activeElement === root) next.focus({ preventScroll: true });
    });
    this.#listen(root, 'dragstart', () => this.cancel());
    this.#listen(doc, 'keydown', () => { this.#focusOwner = undefined; });
    this.#listen(doc, 'pointerdown', () => { this.#focusOwner = undefined; });
    this.#listen(view, 'blur', () => { this.#focusOwner = undefined; this.cancel(); this.dismissContext(); });
    this.#listen(root, 'contextmenu', event => {
      if (!this.#owns(event.target)) return;
      // Native selection has already applied the named platform's inside/outside
      // policy. Capture that target, rather than whichever caret exists later.
      this.dismissContext(); this.#context = selection.retain();
    });
    this.#listen(root, 'keydown', event => {
      const e = event as KeyboardEvent;
      if (!this.#owns(e.target)) return;
      if (e.key === 'Escape') { this.cancel(); this.dismissContext(); }
      else if (e.key === 'ContextMenu' || e.key === 'F10' && e.shiftKey) {
        this.dismissContext(); this.#context = selection.retain();
      }
    });
  }
  get state() { return { ...this.#work, active: !!this.#gesture, textDrag: !!this.#gesture?.textDrag, pendingFrame: this.#frame !== undefined, contextTarget: !!this.#context?.active, listeners: this.#listeners.length }; }
  /** Borrowed independently anchored target. Consumers still prepare/revalidate
   * permission, session and anchors through the common command path. */
  get contextTarget(): RetainedSelection | undefined { return this.#context?.active ? this.#context : undefined; }
  /** Restore only after the originating surface has regained focus itself.
   * Dialog cancellation must never refocus an editor after the user moved away. */
  restoreContext(): boolean {
    const root = this.selection.renderer.root, target = this.contextTarget;
    if (this.#disposed || !target || !root.isConnected || root.ownerDocument.activeElement !== root) return false;
    const a = this.selection.resolvePoint(target.range.anchor, target.anchorBias), f = this.selection.resolvePoint(target.range.focus, target.focusBias);
    const native = root.ownerDocument.getSelection();
    if (!a || !f || !native) return false;
    native.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
    return this.selection.capture({ anchor: target.anchorBias, focus: target.focusBias }).type === 'captured';
  }
  dismissContext(): void { this.#context?.dispose(); this.#context = undefined; }
  #owns(target: EventTarget | null): boolean {
    const root = this.selection.renderer.root;
    return !!target && (target as Node).nodeType !== undefined && root.contains(target as Node) && ((target as Element).closest?.('[contenteditable]') ?? (target as Node).parentElement?.closest('[contenteditable]')) === root;
  }
  #listen(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener); this.#listeners.push(() => target.removeEventListener(type, listener));
  }
  #hit(x: number, y: number): { node: Node; offset: number } | undefined {
    const doc = this.selection.renderer.root.ownerDocument as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null; caretRangeFromPoint?(x: number, y: number): Range | null };
    const point = doc.caretPositionFromPoint?.(x, y);
    if (point) return { node: point.offsetNode, offset: point.offset };
    const range = doc.caretRangeFromPoint?.(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : undefined;
  }
  #preserveDragSource(): void {
    const p = this.#gesture;
    if (!p?.textDrag || !p.moved || !p.source?.active || this.#disposed) return;
    const a = this.selection.resolvePoint(p.source.range.anchor, p.source.anchorBias), f = this.selection.resolvePoint(p.source.range.focus, p.source.focusBias);
    const native = this.selection.renderer.root.ownerDocument.getSelection();
    if (!a || !f || !native) { this.cancel(); return; }
    if (native.anchorNode !== a.node || native.anchorOffset !== a.offset || native.focusNode !== f.node || native.focusOffset !== f.offset)
      native.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
  }
  #schedule(): void {
    if (this.#disposed || this.#frame !== undefined) return;
    this.#frame = this.selection.renderer.root.ownerDocument.defaultView!.requestAnimationFrame(() => { this.#frame = undefined; this.#tick(); });
  }
  #tick(): void {
    const p = this.#gesture, selection = this.selection, root = selection.renderer.root, doc = root.ownerDocument, view = doc.defaultView!;
    if (!p || !this.viewport || selection.suspended || doc.activeElement !== root || !p.source?.active) { this.cancel(); return; }
    this.#work.frames++;
    let scrolling = false;
    // At most one scroll write per ancestor per frame. DOM rects are viewport
    // coordinates, so CSS transforms/zoom and nested clipping share the hit space.
    for (let container: HTMLElement | null = root; container; container = container.parentElement) {
      if (!/(auto|scroll)/.test(view.getComputedStyle(container).overflowY) || container.scrollHeight <= container.clientHeight) continue;
      const rect = container.getBoundingClientRect(), edge = Math.min(24, rect.height / 4);
      const delta = p.y < rect.top + edge ? -16 : p.y > rect.bottom - edge ? 16 : 0;
      if (delta) { const before = container.scrollTop; container.scrollTop += delta; this.#work.scrollWrites++; scrolling ||= before !== container.scrollTop; }
    }
    try {
      this.#work.hitTests++;
      const focus = this.viewport.hitTest(p.x, p.y);
      const anchor = p.source.range.anchor;
      if (focus && anchor) {
        this.viewport.reveal(focus);
        // Restore the stable original anchor after reveal, then extend to the
        // validated model point. No engine command/history entry is prepared.
        if (this.#disposed || this.#gesture !== p) return;
        const native = doc.getSelection(), a = selection.resolvePoint(anchor, p.source.anchorBias), f = selection.toDOM(focus);
        if (!native || !a || !f) { this.cancel(); return; }
        native.setBaseAndExtent(a.node, a.offset, f.node, f.offset); selection.capture();
      }
    } catch { this.cancel(); return; }
    if (scrolling) this.#schedule();
  }
  cancel(): void {
    if (this.#frame !== undefined) this.selection.renderer.root.ownerDocument.defaultView!.cancelAnimationFrame(this.#frame);
    this.#frame = undefined; this.#gesture?.source?.dispose(); this.#gesture = undefined;
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#focusOwner = undefined; this.cancel(); this.dismissContext(); this.viewport = undefined;
    for (const remove of this.#listeners.splice(0)) remove();
  }
}
