import { PointerSelection } from '../selection/pointer.js';
import { errorMessage } from '../errors.js';
import type { AnchorResolution, AnchorToken, Bias, EngineHandle, PatchSubscription, StableRange } from "@edit-ac/core";
import type { DOMPosition, DOMRenderer } from "./render.js";

export interface ModelPoint { node: string; offset: number; bias: Bias }
export interface DOMPoint { node: Node; offset: number }
export interface CapturedSelection { range: StableRange; anchorBias: Bias; focusBias: Bias }
/** Independently owned async target, released explicitly or on bridge disposal. */
export interface RetainedSelection extends CapturedSelection { readonly active: boolean; dispose(): void }
export type CaptureResult = { type: "captured"; selection: CapturedSelection } | { type: "outside" | "unsupported"; reason: string };
export type RestoreResult = { type: "restored" } | { type: "outside" | "empty" }
  | { type: "stale"; anchor: AnchorResolution; focus: AnchorResolution }
  | { type: "unsupported"; reason: string };

/** Internal bridge. Capture synchronously before preparing a command; native
 * selectionchange also captures user navigation. Tokens belong to this bridge
 * until the next capture/clear/dispose. No absolute target survives a patch.
 */
export class DOMSelection {
  readonly pointer: PointerSelection;
  #captured: CapturedSelection | undefined;
  readonly #retained = new Set<RetainedSelection>();
  readonly #subscription: PatchSubscription;
  #disposed = false;
  /** Native composition temporarily owns caret and mutable text positions. */
  suspended = false;
  lastResult: RestoreResult = { type: "empty" };
  readonly #changed = (): void => {
    if (!this.#disposed && !this.suspended) this.capture();
  };
  readonly #engine: EngineHandle;
  constructor(readonly renderer: DOMRenderer, engine: EngineHandle) {
    this.#engine = engine;
    this.pointer = new PointerSelection(this);
    renderer.root.ownerDocument.addEventListener("selectionchange", this.#changed);
    // Construct after the renderer: its synchronous subscription patches first.
    this.#subscription = engine.subscribe({ type: "all" }, patch => {
      if (patch.changedNodes.length && !this.#disposed && !this.suspended) this.lastResult = this.restore();
    });
  }
  get current(): CapturedSelection | undefined { return this.#captured; }
  #native(): Selection | null { return this.renderer.root.ownerDocument.getSelection(); }
  #inside(selection: Selection): boolean {
    const root = this.renderer.root;
    const owned = (node: Node | null) => {
      if (!node || !root.contains(node)) return false;
      const element = node.nodeType === 1 ? node as Element : node.parentElement;
      if (element?.closest('[contenteditable]') === root) return true;
      // Owned noneditable decorations are inside the surface but remain
      // unsupported mapping targets. A foreign editable root is outside.
      return element?.closest<HTMLElement>('[contenteditable]')?.contentEditable === 'false' && !!this.renderer.getNodeId(node);
    };
    return owned(selection.anchorNode) && owned(selection.focusNode);
  }
  /** Map owned text/BR positions and whole-atom boundaries, never atom interiors. */
  toModel(node: Node, offset: number, bias: Bias = "right"): ModelPoint | undefined {
    const root = this.renderer.root, doc = root.ownerDocument;
    const limit = node.nodeType === 3 ? (node as Text).length : node.childNodes.length;
    if (!root.contains(node) || !Number.isSafeInteger(offset) || offset < 0 || offset > limit) return undefined;
    for (let at: Node | null = node; at && at !== root; at = at.parentNode) {
      if (at.nodeType === 1 && ["false", "true"].includes((at as HTMLElement).contentEditable)) return undefined;
    }
    // A Range may point inside the zero-child BR element itself.
    if (node.nodeName === "BR" && node.parentNode) {
      return this.toModel(node.parentNode, Array.prototype.indexOf.call(node.parentNode.childNodes, node), bias);
    }
    const id = this.renderer.getNodeId(node);
    const ids = id && this.renderer.positions(id).length ? [id] : this.#engine.read().visible.filter(node => node.kind === 'block' && root.contains(this.renderer.getBlock(node.id) ?? null)).map(node => node.id);
    const point = doc.createRange(); point.setStart(node, offset); point.collapse(true);
    let previous: ModelPoint | undefined;
    for (const owner of ids) {
      const positions = this.renderer.positions(owner), block = this.renderer.getBlock(owner);
      if (block?.contentEditable === 'false' && block.parentNode) {
        const index = Array.prototype.indexOf.call(block.parentNode.childNodes, block) as number;
        const marker = doc.createRange(); marker.setStart(block.parentNode, index); marker.collapse(true);
        if (point.compareBoundaryPoints(0, marker) <= 0) return { node: owner, offset: 0, bias };
        marker.setStart(block.parentNode, index + 1); marker.collapse(true);
        const end = { node: owner, offset: this.#engine.read().visible.find(n => n.id === owner)?.runs.reduce((n, run) => n + run.text.length, 0) ?? 0, bias };
        const comparison = point.compareBoundaryPoints(0, marker);
        if (comparison <= 0) return end;
        previous = end; continue;
      }
      for (const position of positions) {
        const start = this.#boundary(position, false), end = this.#boundary(position, true);
        const marker = doc.createRange(); marker.setStart(start.node, start.offset); marker.collapse(true);
        const before = point.compareBoundaryPoints(0, marker);
        if (before <= 0) return id ? { node: owner, offset: position.start, bias } : bias === "left" && previous ? previous : { node: owner, offset: position.start, bias };
        marker.setStart(end.node, end.offset); marker.collapse(true);
        const after = point.compareBoundaryPoints(0, marker);
        if (after < 0) {
          if (position.node === node && node.nodeType === 3) return { node: owner, offset: position.start + offset, bias };
          return undefined;
        }
        previous = { node: owner, offset: position.start + position.length, bias };
        if (after === 0 && (id || bias === "left")) return previous;
      }
    }
    return previous;
  }
  /** Resolve an owned stable target without changing the visible selection. */
  resolvePoint(token: AnchorToken, bias: Bias): DOMPoint | undefined {
    const point = this.#engine.resolve(token);
    return point.type === 'position' ? this.toDOM({ ...point, bias }) : undefined;
  }
  toDOM(point: ModelPoint): DOMPoint | undefined {
    const positions = this.renderer.positions(point.node);
    const block = this.renderer.getBlock(point.node);
    if (!block || !this.renderer.root.contains(block) || !Number.isSafeInteger(point.offset) || point.offset < 0) return undefined;
    const length = block.contentEditable === 'false' ? this.#engine.read().visible.find(n => n.id === point.node)?.runs.reduce((n, run) => n + run.text.length, 0) ?? 0 : positions.reduce((n, p) => n + p.length, 0);
    if (point.offset > length) return undefined;
    if (block.contentEditable === 'false' && block.parentNode) {
      if (point.offset !== 0 && point.offset !== length) return undefined;
      const index = Array.prototype.indexOf.call(block.parentNode.childNodes, block) as number;
      return { node: block.parentNode, offset: index + (point.offset === length && (length > 0 || point.bias === 'right') ? 1 : 0) };
    }
    if (!positions.length) return undefined;
    if (length === 0) return { node: block, offset: 0 };
    const candidates: DOMPoint[] = [];
    for (const position of positions) {
      if (point.offset < position.start || point.offset > position.start + position.length) continue;
      const atom = position.node.parentElement?.closest<HTMLElement>('[contenteditable="false"]');
      if (atom && atom !== this.renderer.root && this.renderer.root.contains(atom)) {
        const parts = positions.filter(p => atom.contains(p.node));
        const first = parts[0]!, last = parts[parts.length - 1]!;
        if (point.offset !== first.start && point.offset !== last.start + last.length) continue;
        const parent = atom.parentNode!, index = Array.prototype.indexOf.call(parent.childNodes, atom) as number;
        candidates.push({ node: parent, offset: index + (point.offset === first.start ? 0 : 1) });
      }
      else if (position.node.nodeType === 3) candidates.push({ node: position.node, offset: point.offset - position.start });
      else candidates.push(this.#boundary(position, point.offset > position.start));
    }
    return point.bias === "left" ? candidates[0] : candidates[candidates.length - 1];
  }
  #boundary(position: DOMPosition, end: boolean): DOMPoint {
    if (position.node.nodeType === 3) return { node: position.node, offset: end ? position.length : 0 };
    const parent = position.node.parentNode!;
    const index = Array.prototype.indexOf.call(parent.childNodes, position.node) as number;
    return { node: parent, offset: index + (end ? 1 : 0) };
  }
  /** An exact DOM node range is a node action, never an adjacent text range. */
  selectedNode(): string | undefined {
    const native = this.#native();
    if (this.#disposed || !native?.anchorNode || native.anchorNode !== native.focusNode ||
        Math.abs(native.anchorOffset - native.focusOffset) !== 1) return undefined;
    const element = native.anchorNode.childNodes[Math.min(native.anchorOffset, native.focusOffset)];
    const id = element && this.renderer.getNodeId(element);
    return id && (element as HTMLElement).contentEditable === 'false' && this.renderer.getBlock(id) === element ? id : undefined;
  }
  /** Select inline atoms; block adjacency stays with semantic keyboard policy. */
  selectAdjacentAtom(backward: boolean): boolean {
    const native = this.#native();
    if (this.#disposed || !native?.isCollapsed || !native.anchorNode || !this.#inside(native)) return false;
    const point = this.toModel(native.anchorNode, native.anchorOffset, backward ? 'left' : 'right');
    if (!point) return false;
    for (const element of this.renderer.root.querySelectorAll<HTMLElement>('[contenteditable="false"]')) {
      if (!element.parentNode || element.closest('[data-module-view]') || element.parentElement?.closest('[contenteditable="false"]')) continue;
      // Static checklist markers and host decorations are not semantic atoms.
      const owner = this.renderer.getNodeId(element);
      if (!element.hasAttribute('data-module-type') || !owner || this.renderer.getBlock(owner) === element) continue;
      const parent = element.parentNode, index = Array.prototype.indexOf.call(parent.childNodes, element) as number;
      const edge = this.toModel(parent, index + (backward ? 1 : 0), backward ? 'left' : 'right');
      if (!edge || edge.node !== point.node || edge.offset !== point.offset) continue;
      const range = this.renderer.root.ownerDocument.createRange(); range.selectNode(element);
      native.removeAllRanges(); native.addRange(range); this.clear();
      if (!this.selectedNode()) this.capture();
      return true;
    }
    return false;
  }
  capture(affinity?: { anchor: Bias; focus: Bias }): CaptureResult {
    if (this.#disposed) return { type: "unsupported", reason: "selection bridge disposed" };
    const native = this.#native();
    if (!native || !this.#inside(native)) { this.clear(); return { type: "outside", reason: "selection is outside this editor" }; }
    const anchorBias = affinity?.anchor ?? this.#captured?.anchorBias ?? "right";
    const focusBias = affinity?.focus ?? this.#captured?.focusBias ?? "right";
    const anchor = this.toModel(native.anchorNode!, native.anchorOffset, anchorBias);
    const focus = this.toModel(native.focusNode!, native.focusOffset, focusBias);
    if (this.selectedNode() || !anchor || !focus) { this.clear(); return { type: "unsupported", reason: "selection endpoint is not editable mapped content" }; }
    let a: StableRange["anchor"] | undefined;
    try {
      a = this.#engine.anchor(anchor.node, anchor.offset, anchor.bias);
      const f = this.#engine.anchor(focus.node, focus.offset, focus.bias);
      this.clear(false); this.#captured = { range: { anchor: a, focus: f }, anchorBias, focusBias };
      this.renderer.moduleRuntime?.setSelection({ anchor: this.#engine.resolve(a), focus: this.#engine.resolve(f) });
      return { type: "captured", selection: this.#captured };
    } catch (error) {
      if (a) this.#engine.releaseAnchor(a);
      this.clear(); return { type: "unsupported", reason: errorMessage(error) };
    }
  }
  /** Capture an independently owned range before crossing an async boundary.
   * Later navigation and patch restoration cannot release or redirect it.
   */
  retain(): RetainedSelection | undefined {
    const result = this.capture();
    if (result.type !== "captured") return undefined;
    const anchor = this.#engine.resolve(result.selection.range.anchor), focus = this.#engine.resolve(result.selection.range.focus);
    if (anchor.type !== "position" || focus.type !== "position") return undefined;
    const a = this.#engine.anchor(anchor.node, anchor.offset, result.selection.anchorBias);
    let f: StableRange["focus"];
    try { f = this.#engine.anchor(focus.node, focus.offset, result.selection.focusBias); }
    catch (error) { this.#engine.releaseAnchor(a); throw error; }
    let active = true;
    const selection: RetainedSelection = {
      range: { anchor: a, focus: f }, anchorBias: result.selection.anchorBias, focusBias: result.selection.focusBias,
      get active() { return active; },
      dispose: () => {
        if (!active) return;
        active = false; this.#retained.delete(selection);
        this.#release(selection.range);
      }
    };
    this.#retained.add(selection); return selection;
  }
  /** Scroll only the caret, without rewriting the native selection/preferred x. */
  ensureVisible(): void {
    const root = this.renderer.root, doc = root.ownerDocument, native = this.#native();
    if (this.#disposed || this.suspended || doc.activeElement !== root || !native?.focusNode || !this.#inside(native)) return;
    const range = doc.createRange(); range.setStart(native.focusNode, native.focusOffset); range.collapse(true);
    let rect = range.getBoundingClientRect();
    if (!rect.height) {
      const point = this.toModel(native.focusNode, native.focusOffset);
      const block = point && this.renderer.getBlock(point.node);
      if (!block) return;
      rect = block.getBoundingClientRect();
    }
    for (let container: HTMLElement | null = root; container; container = container.parentElement) {
      const style = doc.defaultView?.getComputedStyle(container);
      if (!style || !/(auto|scroll)/.test(style.overflowY) || container.scrollHeight <= container.clientHeight) continue;
      const bounds = container.getBoundingClientRect();
      const delta = rect.top < bounds.top ? rect.top - bounds.top : rect.bottom > bounds.top + container.clientHeight ? rect.bottom - bounds.top - container.clientHeight : 0;
      if (delta) { container.scrollTop += delta; rect = range.getBoundingClientRect(); }
    }
    const view = doc.defaultView;
    if (view && rect.height) {
      const delta = rect.top < 0 ? rect.top : rect.bottom > view.innerHeight ? rect.bottom - view.innerHeight : 0;
      if (delta) view.scrollBy(0, delta);
    }
  }
  /** Native range scoped to this surface, including intervening noneditable atoms.
   * Navigation does not prepare an engine command or create history.
   */
  selectAll(): boolean {
    if (this.#disposed) return false;
    const root = this.renderer.root, native = this.#native();
    if (!native || root.ownerDocument.activeElement !== root) return false;
    native.setBaseAndExtent(root, 0, root, root.childNodes.length);
    this.capture({ anchor: 'left', focus: 'right' });
    return true;
  }
  /** Place mapped points without changing token ownership or capture policy. */
  place(anchor: ModelPoint, focus: ModelPoint = anchor): boolean {
    const a = this.toDOM(anchor), f = focus === anchor ? a : this.toDOM(focus);
    if (!a || !f) return false;
    const native = this.renderer.root.ownerDocument.getSelection();
    if (a.node === f.node && a.offset === f.offset) native?.collapse(a.node, a.offset);
    else native?.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
    return true;
  }
  move(token: AnchorToken): void { this.restoreRange({ anchor: token, focus: token }); }
  /** Restore semantic endpoints with their resolved affinity; caller owns tokens. */
  restoreRange(range: StableRange): void {
    const a = this.#engine.resolve(range.anchor), f = range.focus === range.anchor ? a : this.#engine.resolve(range.focus);
    if (a.type === "position" && f.type === "position") {
      // A semantic atom bookmark has one logical cut; its view is a node range.
      const element = a.node === f.node && a.offset === 0 && f.offset === 0 ? this.renderer.getBlock(a.node) : undefined;
      const tuple = element && this.#engine.read().visible.find(n => n.id === a.node)?.blockAttributes;
      const atom = Array.isArray(tuple) && (tuple[0] === 'separator' || typeof tuple[0] === 'string' && tuple[0].startsWith('module:'));
      if (atom && element?.contentEditable === 'false' && element.parentNode) {
        const range = this.renderer.root.ownerDocument.createRange(); range.selectNode(element);
        const native = this.#native(); native?.removeAllRanges(); native?.addRange(range); this.clear();
      } else if (this.place(a, f)) this.capture({ anchor: a.bias, focus: f.bias });
    }
  }
  restoreRetained(target: RetainedSelection): void { this.restoreRange(target.range); }
  restore(): RestoreResult {
    if (this.#disposed || !this.#captured) return { type: "empty" };
    const native = this.#native();
    if (!native || !this.#inside(native)) { this.clear(); return { type: "outside" }; }
    // A retained native range can outlive focus on a toolbar or another editor.
    // A remote patch must not activate that range and steal the current focus.
    const active = this.renderer.root.ownerDocument.activeElement;
    if (active && active !== this.renderer.root) return { type: "outside" };
    const anchor = this.#engine.resolve(this.#captured.range.anchor), focus = this.#engine.resolve(this.#captured.range.focus);
    if (anchor.type !== "position" || focus.type !== "position") {
      native.removeAllRanges(); this.clear(); return { type: "stale", anchor, focus };
    }
    const a = this.toDOM({ ...anchor, bias: this.#captured.anchorBias }), f = this.toDOM({ ...focus, bias: this.#captured.focusBias });
    if (!a || !f) { native.removeAllRanges(); this.clear(); return { type: "unsupported", reason: "selection endpoint is not editable mapped content" }; }
    // Preserve the browser's preferred vertical x/visual affinity on unrelated
    // patches. Reapplying identical endpoints resets native navigation state.
    if (native.anchorNode !== a.node || native.anchorOffset !== a.offset || native.focusNode !== f.node || native.focusOffset !== f.offset)
      native.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
    return { type: "restored" };
  }
  #release(range: StableRange): void {
    this.#engine.releaseAnchor(range.anchor); this.#engine.releaseAnchor(range.focus);
  }
  clear(notify = true): void {
    if (notify) this.renderer.moduleRuntime?.setSelection(null);
    if (!this.#captured) return;
    const range = this.#captured.range; this.#captured = undefined;
    this.#release(range);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.renderer.root.ownerDocument.removeEventListener("selectionchange", this.#changed);
    this.pointer.dispose();
    this.#subscription.dispose(); this.clear();
    for (const selection of this.#retained) selection.dispose();
  }
}
