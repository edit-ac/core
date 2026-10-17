import type { CommitResult, EngineHandle, MoveTarget, PatchSubscription, PrepareRequest, ProjectedNode } from '@edit-ac/core';
import type { DOMSelection, RetainedSelection } from '../dom/selection.js';

export interface ReorderContext {
  root: HTMLElement;
  engine: EngineHandle;
  selection: DOMSelection;
  commit(request: PrepareRequest): CommitResult;
  /** Composition and open command presenters keep priority over reorder UI. */
  blocked?(): boolean;
  /** Copy uses the host clipboard preparation and captured destination, never a move. */
  copyDrop?(event: DragEvent, target: string): boolean;
}
export type ReorderFactory = (context: ReorderContext) => ReorderPresenter;
/** Optional UI only; the engine validates all topology and owns the one move. */
export function reorderControls(): ReorderFactory { return context => new ReorderPresenter(context); }
const blockDragMime = 'application/x-editac-block';
interface PointerSession {
  id: number; x: number; y: number; startX: number; startY: number; threshold: number;
  active: boolean; sampled: boolean; destination?: { parent: MoveTarget; before: MoveTarget | null; hovered: MoveTarget; after: boolean } | undefined;
}
interface Target { target: MoveTarget; selection: RetainedSelection }

export class ReorderPresenter {
  readonly controls: HTMLElement;
  readonly status: HTMLElement;
  private readonly up: HTMLButtonElement;
  private readonly down: HTMLButtonElement;
  private readonly grip: HTMLButtonElement;
  private pointer: PointerSession | undefined;
  private frame: number | undefined;
  private readonly work = { frames: 0, hitTests: 0, geometryReads: 0, scrollWrites: 0 };
  /** Derived interaction diagnostics; no document state or retained DOM references. */
  get pointerState() { return { ...this.work, active: !!this.pointer?.active, pendingFrame: this.frame !== undefined, captured: !!this.pointer, retainedSelection: !!this.session?.selection.active, listeners: this.listeners.length, subscribed: !this.disposed }; }
  private readonly nodes = new Map<string, ProjectedNode>();
  private readonly subscription: PatchSubscription;
  private readonly listeners: [EventTarget, string, EventListener, boolean | AddEventListenerOptions][] = [];
  private session: Target | undefined;
  private readOnly = false;
  private composing = false;
  private escapeFocus = false;
  private disposed = false;
  private readonly dragScope: string;
  private dragSequence = 0;
  private dragToken: string | undefined;

  constructor(private readonly context: ReorderContext) {
    const { root, engine } = context, doc = root.ownerDocument;
    this.dragScope = [...doc.defaultView!.crypto.getRandomValues(new Uint32Array(4))].join('-');
    this.controls = doc.createElement('div');
    this.controls.setAttribute('role', 'group'); this.controls.setAttribute('aria-label', 'Reorder block');
    this.controls.contentEditable = 'false';
    this.up = doc.createElement('button'); this.down = doc.createElement('button');
    for (const [button, label] of [[this.up, 'Move block up'], [this.down, 'Move block down']] as const) {
      button.type = 'button'; button.style.minWidth = button.style.minHeight = '44px'; button.textContent = label; this.controls.append(button);
      this.listen(button, 'pointerdown', () => { this.begin(); });
    }
    this.grip = doc.createElement('button'); this.grip.type = 'button';
    this.grip.textContent = 'Drag selected block'; this.grip.setAttribute('aria-label', 'Drag selected block');
    this.grip.style.minWidth = this.grip.style.minHeight = '44px';
    this.grip.style.touchAction = 'none'; this.controls.append(this.grip);
    this.listen(this.grip, 'pointerdown', event => {
      const e = event as PointerEvent;
      if (e.defaultPrevented || e.button !== 0 || !e.isPrimary || this.pointer || !this.begin()) return;
      e.preventDefault();
      const box = this.grip.getBoundingClientRect();
      this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
        threshold: Math.max(4, Math.min(12, Math.min(box.width, box.height) / 4)), active: false, sampled: false };
      try { this.grip.setPointerCapture(e.pointerId); } catch { this.cancel(); }
    });
    this.listen(this.grip, 'pointermove', event => {
      const e = event as PointerEvent, p = this.pointer;
      if (!p || p.id !== e.pointerId) return;
      if (this.blocked()) { this.cancel(); return; }
      p.x = e.clientX; p.y = e.clientY;
      if (!p.active && Math.hypot(p.x - p.startX, p.y - p.startY) >= p.threshold) p.active = true;
      if (p.active) { e.preventDefault(); this.schedulePointer(); }
    });
    this.listen(this.grip, 'pointerup', event => {
      const e = event as PointerEvent, p = this.pointer;
      if (!p || p.id !== e.pointerId) return;
      e.preventDefault();
      if (!p.active || this.blocked()) { this.restore(); this.cancel(); return; }
      // Re-hit-test on release. A deleted/replaced captured target must never
      // silently become its next neighbour even when layout moved underneath it.
      const captured = p.destination, sampled = p.sampled;
      p.x = e.clientX; p.y = e.clientY;
      this.pointerFrame(false);
      const current = p.destination;
      if (!current || (sampled && JSON.stringify(captured) !== JSON.stringify(current))) {
        this.restore(); this.cancel(); this.status.textContent = 'Move canceled. Destination changed.'; return;
      }
      if (current.after) {
        const hovered = this.nodes.get(current.hovered.id);
        if (!hovered?.editor || hovered.editor.version !== current.hovered.version) { this.restore(); this.cancel(); return; }
        const next = [...this.nodes.values()].filter(n => n.parent === hovered.parent && n.order > hovered.order).sort((a,b) => a.order - b.order)[0];
        this.moveCaptured(current.parent, next ? this.target(next.id) : null);
      } else this.moveCaptured(current.parent, current.before);
    });
    for (const type of ['pointercancel', 'lostpointercapture']) this.listen(this.grip, type, event => {
      if (this.pointer?.id === (event as PointerEvent).pointerId) { this.restore(); this.cancel(); this.status.textContent = 'Move canceled.'; }
    });
    // A competing touch hands scroll/pinch arbitration back to the browser.
    // Observe it without canceling its default action or taking its capture.
    this.listen(doc, 'pointerdown', event => {
      const e = event as PointerEvent;
      if (this.pointer && e.pointerId !== this.pointer.id && e.pointerType === 'touch') {
        this.restore(); this.cancel(); this.status.textContent = 'Move canceled.';
      }
    }, { capture: true, passive: true });
    this.listen(doc.defaultView!, 'blur', () => { if (this.pointer) { this.restore(); this.cancel(); } });
    this.up.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp'); this.down.setAttribute('aria-keyshortcuts', 'Alt+ArrowDown');
    this.status = doc.createElement('span'); this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite'); this.controls.append(this.status); root.after(this.controls);
    for (const node of engine.read().visible) this.nodes.set(node.id, node);
    this.subscription = engine.subscribe({ type: 'all' }, patch => {
      for (const change of patch.nodes) {
        if (change.type === 'visible') this.nodes.set(change.node.id, change.node);
        else this.nodes.delete(change.type === 'removed' ? change.id : change.node.id);
      }
    });
    this.listen(this.up, 'click', () => { this.moveBy(-1); });
    this.listen(this.down, 'click', () => { this.moveBy(1); });
    const keyboard = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.key === 'Escape' && this.pointer) { key.preventDefault(); key.stopImmediatePropagation(); this.restore(); this.cancel(); this.status.textContent = 'Move canceled.'; return; }
      if (this.composing || this.disposed || context.blocked?.()) return;
      const target = event.target as Element | null;
      if (target && root.contains(target) && target.closest('input, textarea, select, button, [contenteditable="false"]')) return;
      if (key.isComposing || key.key === 'Process' || key.getModifierState('AltGraph')) return;
      const escape = this.escapeFocus;
      if (!['Alt', 'Control', 'Meta', 'Shift'].includes(key.key)) this.escapeFocus = false;
      if (key.key === 'Escape') {
        if (this.session) { this.restore(); this.cancel(); }
        this.escapeFocus = true; key.preventDefault(); key.stopImmediatePropagation(); return;
      }
      if (key.key === 'Tab') {
        const active = doc.activeElement;
        if (root.contains(active)) {
          this.begin();
          if (escape && !key.shiftKey && !this.readOnly && !this.composing) {
            key.preventDefault(); key.stopImmediatePropagation(); this.up.focus(); return;
          }
        } else if (active === this.up && !key.shiftKey || active === this.down && key.shiftKey) {
          key.preventDefault(); (active === this.up ? this.down : this.up).focus(); return;
        } else if (active === this.up && key.shiftKey) {
          key.preventDefault(); this.restore(); this.cancel(); return;
        }
      } else if (root.contains(doc.activeElement) && !['Alt', 'Control', 'Meta', 'Shift', 'ArrowUp', 'ArrowDown'].includes(key.key)) this.cancel();
      if (key.altKey && !key.ctrlKey && !key.metaKey && !key.shiftKey && (key.key === 'ArrowUp' || key.key === 'ArrowDown')) {
        if (this.readOnly || this.composing || this.disposed) return;
        key.preventDefault(); key.stopImmediatePropagation(); this.moveBy(key.key === 'ArrowUp' ? -1 : 1);
      }
    };
    const nodeAt = (event: Event, allowHandle = false): string | undefined => {
      const target = event.target as Element | null;
      if (!target || !root.contains(target) || target.closest('input, textarea, select, button')) return undefined;
      const control = target.closest('[contenteditable="false"]');
      // Native HTML drag in an editing host needs an explicit noneditable grip.
      // An embedded control is still its own owner unless the host opts this
      // mapped grip into block reorder. Never infer ownership from draggable.
      if (control && !(allowHandle && control.matches('[data-editac-reorder-handle][draggable="true"]') && context.selection.renderer.ownsModuleDecoration(control))) return undefined;
      return context.selection.renderer.getNodeId(target);
    };
    this.listen(root, 'pointerdown', event => {
      const target = event.target as Element | null;
      if (target?.closest('[data-editac-reorder-handle]')) {
        const id = nodeAt(event, true);
        if (id) this.begin(id);
      }
    }, true);
    this.listen(root, 'dragstart', event => {
      const drag = event as DragEvent, id = nodeAt(event, true), node = id && this.nodes.get(id);
      if (event.defaultPrevented || !drag.dataTransfer || !node || this.blocked() || !(this.session?.target.id === id || this.begin(id))) return;
      this.dragToken = `${this.dragScope}:${++this.dragSequence}`;
      drag.dataTransfer.setData(blockDragMime, this.dragToken);
      // This optional block handle offers literal source text for copy. Rich
      // cross-editor offers remain with their owning codecs/clipboard host.
      drag.dataTransfer.setData('text/plain', node.runs.map(r=>r.text).join(''));
      drag.dataTransfer.effectAllowed = 'copyMove';
    }, true);
    this.listen(root, 'dragover', event => {
      const drag=event as DragEvent;
      if (this.dragToken && drag.dataTransfer?.types.includes(blockDragMime) && nodeAt(event) && !this.blocked()) event.preventDefault();
    }, true);
    this.listen(root, 'drop', event => {
      const drag=event as DragEvent, token=drag.dataTransfer?.getData(blockDragMime);
      if (!this.dragToken || token !== this.dragToken) return;
      if (event.defaultPrevented) { this.cancel(); return; }
      const element=event.target as Element | null;
      if (element?.closest('input, textarea, select, button, [contenteditable="false"]')) { this.cancel(); return; }
      const id=nodeAt(event), destination=id && this.nodes.get(id);
      if (!event.cancelable || !destination || this.blocked()) {
        if(event.cancelable)event.preventDefault();this.cancel();return;
      }
      if(drag.ctrlKey || drag.metaKey || drag.altKey || drag.dataTransfer?.dropEffect==='copy') {
        // Release source selection without restoring it over the drop target.
        this.cancel();
        if (!context.copyDrop?.(drag,destination.id)) { event.preventDefault(); this.status.textContent='Block copy unavailable. Source preserved.'; }
      } else {
        event.preventDefault(); this.moveTo(destination.parent,destination.id);
      }
      event.stopPropagation();
    }, true);
    this.listen(root, 'dragend', () => this.cancel(), true);
    this.listen(doc, 'keydown', event => { if (this.pointer && (event as KeyboardEvent).key === 'Escape') keyboard(event); }, true);
    this.listen(root, 'keydown', keyboard, true); this.listen(this.controls, 'keydown', keyboard, true);
    this.listen(root, 'compositionstart', () => { this.composing = true; this.cancel(); this.updateDisabled(); }, true);
    this.listen(root, 'compositionend', () => { this.composing = false; this.updateDisabled(); }, true);
    this.listen(doc, 'focusin', () => { const active = doc.activeElement; if (!root.contains(active) && !this.controls.contains(active)) this.cancel(); });
  }
  private blocked(): boolean { return this.disposed || this.readOnly || this.composing || !!this.context.blocked?.(); }
  /** Capture identity/version and independent relative selection before UI focus. */
  begin(id?: string): boolean {
    if (this.blocked()) return false;
    if (!this.context.root.contains(this.context.root.ownerDocument.activeElement) && id === undefined) return !!this.session;
    this.cancel();
    const selection = this.context.selection.retain();
    if (!selection) { this.status.textContent = 'Select a block to move.'; return false; }
    const anchor = this.context.engine.resolve(selection.range.anchor);
    const node = this.nodes.get(id ?? (anchor.type === 'position' ? anchor.node : ''));
    if (!node?.editor) { selection.dispose(); this.status.textContent = 'This block cannot be moved.'; return false; }
    this.session = { target: { id: node.id, version: node.editor.version }, selection }; return true;
  }
  private target(id: string): MoveTarget {
    if (id === '@root') return { id, version: 'base' };
    const node = this.nodes.get(id);
    if (!node?.editor) throw Error('Destination is unavailable');
    return { id, version: node.editor.version };
  }
  /** Explicit host UI destination. Never repair or redirect an invalid target. */
  moveTo(parent: string, before?: string | null): boolean {
    if (this.blocked() || !this.session) return false;
    try { return this.moveCaptured(this.target(parent), before == null ? null : this.target(before)); }
    catch { this.restore(); this.cancel(); this.status.textContent = 'Block could not be moved. Document unchanged.'; return false; }
  }
  private moveCaptured(parent: MoveTarget, before: MoveTarget | null): boolean {
    if (this.blocked() || !this.session) return false;
    try {
      const source = this.nodes.get(this.session.target.id);
      if (source?.parent === parent.id) {
        const next = [...this.nodes.values()].filter(n => n.parent === parent.id && n.order > source.order).sort((a,b) => a.order - b.order)[0];
        if (before?.id === source.id || (before?.id ?? null) === (next?.id ?? null)) {
          this.restore(); this.status.textContent = 'Block is already at the boundary.'; return false;
        }
      }
      const command = { type: 'move' as const, target: this.session.target, parent, before };
      this.context.engine.history({ type: 'boundary' });
      const result = this.context.commit({ kind: 'editor', origin: 'module-reorder', commands: [command] });
      if (result.caret) this.context.engine.releaseAnchor(result.caret);
      this.context.engine.history({ type: 'boundary' });
      this.restore(); this.status.textContent = 'Block moved.'; return true;
    } catch { this.restore(); this.status.textContent = 'Block could not be moved. Document unchanged.'; return false; }
    finally { this.cancel(); }
  }
  moveBy(direction: -1 | 1): boolean {
    if (this.blocked() || (direction !== -1 && direction !== 1)) return false;
    if (this.context.root.contains(this.context.root.ownerDocument.activeElement)) { if (!this.begin()) return false; }
    else if (!this.session && !this.begin()) return false;
    const node = this.nodes.get(this.session!.target.id);
    if (!node) { this.cancel(); this.status.textContent = 'Block is no longer available.'; return false; }
    const siblings = [...this.nodes.values()].filter(n => n.parent === node.parent).sort((a, b) => a.order - b.order);
    const index = siblings.findIndex(n => n.id === node.id);
    if (index + direction < 0 || index + direction >= siblings.length) {
      this.restore(); this.cancel(); this.status.textContent = 'Block is already at the boundary.'; return false;
    }
    return this.moveTo(node.parent, direction === -1 ? siblings[index - 1]!.id : siblings[index + 2]?.id ?? null);
  }
  private restore(): void {
    if (!this.session) return;
    const { engine, selection, root } = this.context, range = this.session.selection.range;
    const a = engine.resolve(range.anchor), f = engine.resolve(range.focus);
    if (a.type !== 'position' || f.type !== 'position') return;
    const anchor = selection.toDOM({ ...a, bias: this.session.selection.anchorBias });
    const focus = selection.toDOM({ ...f, bias: this.session.selection.focusBias });
    if (anchor && focus) { root.focus({ preventScroll: true }); root.ownerDocument.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset); selection.capture(); }
  }
  private schedulePointer(): void {
    if (this.frame !== undefined || !this.pointer?.active) return;
    this.frame = this.context.root.ownerDocument.defaultView!.requestAnimationFrame(() => {
      this.frame = undefined; this.pointerFrame(true);
    });
  }
  private pointerFrame(scroll: boolean): void {
    const p = this.pointer, { root, selection } = this.context;
    if (!p?.active) return;
    if (this.blocked()) { this.cancel(); return; }
    p.sampled = true; this.work.frames++;
    const doc = root.ownerDocument;
    // elementFromPoint uses the browser's spatial index: no per-frame walk of
    // the engine projection or all 2,000 block rectangles.
    const element = doc.elementFromPoint(p.x, p.y); this.work.hitTests++;
    p.destination = undefined;
    if (element && root.contains(element) && !element.closest('input,textarea,select,button,[contenteditable="false"]')) {
      const id = selection.renderer.getNodeId(element), node = id ? this.nodes.get(id) : undefined;
      const block = id && selection.renderer.getBlock(id);
      const source = this.session && this.nodes.get(this.session.target.id);
      if (node?.editor && block && source && node.id !== source.id && node.parent === source.parent) {
        const rect = block.getBoundingClientRect(); this.work.geometryReads++;
        const after = p.y >= (rect.top + rect.bottom) / 2;
        // Capture the hovered identity now; defer sibling lookup until release.
        p.destination = { parent: this.target(node.parent), before: this.target(node.id), hovered: this.target(node.id), after };
        this.status.textContent = `Move ${after ? 'after' : 'before'} block ${node.order + 1}.`;
      }
    }
    if (!p.destination) this.status.textContent = 'No move destination.';
    if (scroll) {
      const scroller = root.scrollHeight > root.clientHeight ? root : doc.scrollingElement;
      const bounds = scroller === root ? root.getBoundingClientRect() : { top: 0, bottom: doc.defaultView!.innerHeight, left: 0, right: doc.defaultView!.innerWidth };
      this.work.geometryReads++;
      const edge = Math.min(48, (bounds.bottom - bounds.top) / 4);
      const delta = p.y < bounds.top + edge ? -16 : p.y > bounds.bottom - edge ? 16 : 0;
      if (scroller && delta && p.y >= bounds.top && p.y <= bounds.bottom && p.x >= bounds.left && p.x <= bounds.right) {
        const top = scroller.scrollTop; scroller.scrollTop += delta; this.work.scrollWrites++;
        if (scroller.scrollTop !== top) this.schedulePointer();
      }
    }
  }
  /** Existing gesture owner keeps capture on a valid refresh; stale targets are
   * re-hit-tested. Lost coordinate space cancels without a semantic command. */
  refreshGeometry(recoverable: boolean): void {
    if (!this.pointer) return;
    if (!recoverable) { this.cancel(); return; }
    this.pointer.destination=undefined;this.pointer.sampled=false;
    if(this.pointer.active)this.schedulePointer();
  }
  cancel(): void {
    const pointer = this.pointer; this.pointer = undefined;
    if (this.frame !== undefined) this.context.root.ownerDocument.defaultView!.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    if (pointer && this.grip.hasPointerCapture(pointer.id)) this.grip.releasePointerCapture(pointer.id);
    this.dragToken=undefined; this.session?.selection.dispose(); this.session = undefined;
  }
  private updateDisabled(): void { this.up.disabled = this.down.disabled = this.grip.disabled = this.readOnly || this.composing; }
  setReadOnly(value: boolean): void { this.readOnly = value; if (value) this.cancel(); this.updateDisabled(); }
  private listen(target: EventTarget, type: string, listener: EventListener, capture: boolean | AddEventListenerOptions = false): void {
    target.addEventListener(type, listener, capture); this.listeners.push([target, type, listener, capture]);
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.cancel(); this.subscription.dispose();
    for (const [target, type, listener, capture] of this.listeners) target.removeEventListener(type, listener, capture);
    this.listeners.length = 0; this.nodes.clear(); this.controls.remove();
  }
}
