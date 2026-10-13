import type { CommitResult, EngineHandle, MoveTarget, PatchSubscription, PrepareRequest, ProjectedNode } from '@edit-ac/core';
import type { DOMSelection, RetainedSelection } from '../dom/selection.js';

export interface ReorderContext {
  root: HTMLElement;
  engine: EngineHandle;
  selection: DOMSelection;
  commit(request: PrepareRequest): CommitResult;
  /** Composition and open command presenters keep priority over reorder UI. */
  blocked?(): boolean;
}
export type ReorderFactory = (context: ReorderContext) => ReorderPresenter;
/** Optional UI only; the engine validates all topology and owns the one move. */
export function reorderControls(): ReorderFactory { return context => new ReorderPresenter(context); }
interface Target { target: MoveTarget; selection: RetainedSelection }

export class ReorderPresenter {
  readonly controls: HTMLElement;
  readonly status: HTMLElement;
  private readonly up: HTMLButtonElement;
  private readonly down: HTMLButtonElement;
  private readonly nodes = new Map<string, ProjectedNode>();
  private readonly subscription: PatchSubscription;
  private readonly listeners: [EventTarget, string, EventListener, boolean][] = [];
  private session: Target | undefined;
  private readOnly = false;
  private composing = false;
  private escapeFocus = false;
  private disposed = false;

  constructor(private readonly context: ReorderContext) {
    const { root, engine } = context, doc = root.ownerDocument;
    this.controls = doc.createElement('div');
    this.controls.setAttribute('role', 'group'); this.controls.setAttribute('aria-label', 'Reorder block');
    this.controls.contentEditable = 'false';
    this.up = doc.createElement('button'); this.down = doc.createElement('button');
    for (const [button, label] of [[this.up, 'Move block up'], [this.down, 'Move block down']] as const) {
      button.type = 'button'; button.textContent = label; this.controls.append(button);
      this.listen(button, 'pointerdown', () => { this.begin(); });
    }
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
    this.listen(root, 'keydown', keyboard, true); this.listen(this.controls, 'keydown', keyboard, true);
    this.listen(root, 'compositionstart', () => { this.composing = true; this.cancel(); this.updateDisabled(); }, true);
    this.listen(root, 'compositionend', () => { this.composing = false; this.updateDisabled(); }, true);
    this.listen(doc, 'focusin', () => { const active = doc.activeElement; if (!root.contains(active) && !this.controls.contains(active)) this.cancel(); });
  }
  /** Capture identity/version and independent relative selection before UI focus. */
  begin(id?: string): boolean {
    if (this.disposed || this.readOnly || this.composing || this.context.blocked?.()) return false;
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
    if (this.disposed || this.readOnly || this.composing || this.context.blocked?.() || !this.session) return false;
    try {
      const command = { type: 'move' as const, target: this.session.target, parent: this.target(parent), before: before == null ? null : this.target(before) };
      this.context.engine.history({ type: 'boundary' });
      const result = this.context.commit({ kind: 'editor', origin: 'module-reorder', commands: [command] });
      if (result.caret) this.context.engine.releaseAnchor(result.caret);
      this.context.engine.history({ type: 'boundary' });
      this.restore(); this.status.textContent = 'Block moved.'; return true;
    } catch { this.restore(); this.status.textContent = 'Block could not be moved. Document unchanged.'; return false; }
    finally { this.cancel(); }
  }
  moveBy(direction: -1 | 1): boolean {
    if (this.disposed || this.readOnly || this.composing || this.context.blocked?.() || (direction !== -1 && direction !== 1)) return false;
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
  cancel(): void { this.session?.selection.dispose(); this.session = undefined; }
  private updateDisabled(): void { this.up.disabled = this.down.disabled = this.readOnly || this.composing; }
  setReadOnly(value: boolean): void { this.readOnly = value; if (value) this.cancel(); this.updateDisabled(); }
  private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
    target.addEventListener(type, listener, capture); this.listeners.push([target, type, listener, capture]);
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.cancel(); this.subscription.dispose();
    for (const [target, type, listener, capture] of this.listeners) target.removeEventListener(type, listener, capture);
    this.listeners.length = 0; this.nodes.clear(); this.controls.remove();
  }
}
