import type { EngineHandle, Json, Patch, PatchSubscription, ProjectedNode } from "@edit-ac/core";

import { ModuleRegistry } from '../modules/registry.js';
import { ModuleRuntime, type ModuleRuntimeOptions, type ModuleView } from '../modules/runtime.js';
import type { ContentFactory, ContentView } from '../modules/content.js';

export interface DOMPosition { node: Node; start: number; length: number }
type Run = ProjectedNode["runs"][number];
interface RenderedRun { element: HTMLElement; key: string; contentKey: string; text: string; positions: DOMPosition[]; views: { key: string; version: number; kind: 'mark' | 'inline-atom'; view: ModuleView }[] }
interface Entry { node: ProjectedNode; outer: HTMLElement; content: HTMLElement; key: string; runs: RenderedRun[]; contentView?: ContentView; contentDescriptorKey?: string }
const tuple = (value: Json | undefined): Json[] => Array.isArray(value) ? value : [];

/** Internal projection adapter. It renders engine state, never imports DOM state.
 * Input/selection readiness is a separate lifecycle gate. No DOM access at import.
 */
export class DOMRenderer {
  private readonly entries = new Map<string, Entry>();
  private readonly owners = new WeakMap<Node, string>();
  private readonly moduleDecorations = new WeakSet<Node>();
  private readonly subscription: PatchSubscription;
  private disposed = false;
  private readonly held = new Set<string>();
  private readonly deferred = new Map<string, Patch["nodes"][number]>();
  patchBoundary: { before(): void; after(): void } | undefined;
  private revision: number;
  private readonly modules: ModuleRegistry | undefined;
  readonly moduleRuntime: ModuleRuntime | undefined;
  constructor(readonly root: HTMLElement, private readonly engine: EngineHandle, private readonly options: { readOnly?: boolean; modules?: ModuleRegistry; moduleRuntime?: ModuleRuntimeOptions; content?: ContentFactory; commit?: (request: import('@edit-ac/core').PrepareRequest) => import('@edit-ac/core').CommitResult } = {}) {
    this.modules = options.modules?.freeze();
    const snapshot = engine.read();
    this.modules?.validate(snapshot.visible);
    this.moduleRuntime = options.modules || options.moduleRuntime ? new ModuleRuntime(engine, options.moduleRuntime) : undefined;
    this.revision = snapshot.revision;
    root.replaceChildren();
    root.contentEditable = options.readOnly ? "false" : "true";
    const nodes = new Map(snapshot.visible.map(node => [node.id, node]));
    for (const node of snapshot.visible) this.update(node, nodes.get(node.parent));
    this.arrange();
    this.subscription = engine.subscribe({ type: "all" }, patch => this.apply(patch));
  }
  getBlock(id: string): HTMLElement | undefined { return this.entries.get(id)?.content; }
  /** Only adapter-created view decorations own asynchronous DOM mutations.
   * Authored data attributes cannot confer ownership of canonical source. */
  ownsModuleDecoration(node: Node): boolean {
    for (let at: Node | null = node; at && at !== this.root; at = at.parentNode) {
      if (this.moduleDecorations.has(at)) return true;
    }
    return false;
  }
  getNodeId(node: Node): string | undefined {
    for (let at: Node | null = node; at && at !== this.root; at = at.parentNode) {
      const id = this.owners.get(at);
      if (id && this.entries.get(id)?.outer.contains(node)) return id;
    }
    return undefined;
  }
  /** UTF-16 text and hard-break map; empty-block placeholder has length zero. */
  positions(id: string): readonly DOMPosition[] {
    const entry = this.entries.get(id);
    if (!entry) return [];
    let offset = 0;
    return entry.runs.flatMap(run => run.positions.map(position => {
      const result = { ...position, start: offset }; offset += position.length; return result;
    }));
  }
  /** Document-ordered editable blocks, excluding containers and noneditable atoms. */
  textBlockIds(): string[] {
    return [...this.entries.values()].filter(entry => entry.runs.length > 0 && entry.content.contentEditable !== "false")
      .sort((a, b) => a.node.order - b.node.order).map(entry => entry.node.id);
  }
  setReadOnly(value: boolean): void { if (!this.disposed) { this.root.contentEditable = value ? "false" : "true"; for (const entry of this.entries.values()) entry.contentView?.setReadOnly(value); } }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.subscription.dispose(); this.root.contentEditable = "false";
    for (const entry of this.entries.values()) this.disposeRuns(entry);
    this.moduleRuntime?.dispose();
    this.entries.clear(); this.held.clear(); this.deferred.clear(); this.patchBoundary = undefined;
  }
  /** Temporary native ownership; resume projects the latest admitted patch only. */
  hold(id: string): void { this.held.add(id); }
  resume(id: string): void {
    this.held.delete(id);
    let change = this.deferred.get(id); this.deferred.delete(id);
    if (this.disposed) return;
    if (!change) {
      const node = this.entries.get(id)?.node;
      if (node) change = { type: "visible", node };
      else change = { type: "removed", id };
    }
    this.patchBoundary?.before();
    try {
      if (change.type === "visible") {
        const entry = this.entries.get(id);
        if (entry) for (const run of entry.runs) run.text = "\u0000native-owned";
        this.update(change.node, this.entries.get(change.node.parent)?.node);
      }
      else { const entry = this.entries.get(id); if (entry) { this.disposeRuns(entry); entry.outer.remove(); } this.entries.delete(id); }
      this.arrange();
    } finally { this.patchBoundary?.after(); }
  }
  private apply(patch: Patch): void {
    this.patchBoundary?.before();
    try { this.applyOwned(patch); } finally { this.patchBoundary?.after(); }
  }
  private applyOwned(patch: Patch): void {
    if (this.disposed || patch.revision < this.revision) return;
    if (patch.projectionError) throw new Error(`DOM projection failed: ${patch.projectionError}`);
    this.revision = patch.revision;
    let structure = false;
    // Apply metadata first so children see their new parent presentation.
    const changed = new Map<string, ProjectedNode>();
    for (const change of patch.nodes) if (change.type === "visible") changed.set(change.node.id, change.node);
    const parentOf = (node: ProjectedNode) => changed.get(node.parent) ?? this.entries.get(node.parent)?.node;
    for (const change of patch.nodes) {
      const owner = change.type === "removed" ? change.id : change.node.id;
      if (this.held.has(owner)) { this.deferred.set(owner, change); continue; }
      if (change.type !== "visible") {
        const id = change.type === "removed" ? change.id : change.node.id;
        const entry = this.entries.get(id);
        if (entry) { this.disposeRuns(entry); entry.outer.remove(); this.entries.delete(id); structure = true; }
      } else {
        const old = this.entries.get(change.node.id);
        structure ||= !old || old.node.parent !== change.node.parent || old.node.order !== change.node.order;
        const previousOuter = old?.outer;
        this.update(change.node, parentOf(change.node));
        structure ||= previousOuter !== this.entries.get(change.node.id)?.outer;
      }
    }
    // Parent style changes may alter child wrappers/checklist metadata.
    if (structure || patch.operation === "Editor" || patch.operation === "Structure") {
      for (const entry of this.entries.values()) if (!this.held.has(entry.node.id)) this.update(entry.node, parentOf(entry.node));
      this.arrange();
    }
  }
  private update(node: ProjectedNode, parent: ProjectedNode | undefined): void {
    const block = tuple(node.blockAttributes), style = tuple(node.editor?.containerAttributes);
    const isListItem = parent?.kind === "list";
    const tag = node.kind === "list" ? (style[0] === "ordered" ? "ol" : "ul") : node.kind === "quote" ? "blockquote" :
      this.options.content && typeof block[0] === 'string' && block[0].startsWith('module:') ? 'div' : block[0] === "separator" ? "hr" : block[0] === "heading" && Number.isInteger(block[1]) && Number(block[1]) >= 1 && Number(block[1]) <= 6 ? `h${block[1]}` : block[0] === "code" ? "pre" : "p";
    const key = `${tag}:${isListItem}`;
    let entry = this.entries.get(node.id);
    if (!entry || entry.key !== key) {
      const content = this.root.ownerDocument.createElement(tag);
      const outer = isListItem ? this.root.ownerDocument.createElement("li") : content;
      if (outer !== content) outer.append(content);
      const old = entry;
      entry = { node, content, outer, key, runs: [] };
      this.entries.set(node.id, entry);
      this.owners.set(content, node.id); this.owners.set(outer, node.id);
      outer.dataset.nodeId = node.id;
      if (old) { this.disposeRuns(old); old.outer.replaceWith(outer); }
    }
    entry.node = node;
    if (this.options.content) {
      const descriptorKey = JSON.stringify(node.blockAttributes);
      if (entry.contentView && entry.contentDescriptorKey !== descriptorKey && !entry.contentView.update(node)) { entry.contentView.dispose(); delete entry.contentView; entry.content.replaceChildren(); }
      if (!entry.contentView && typeof block[0] === 'string' && block[0].startsWith('module:')) {
        const view = this.options.content({ element: entry.content, node, engine: this.engine,
          commit: this.options.commit ?? (request => this.engine.commit(this.engine.prepare(request))),
          readOnly: this.root.contentEditable === 'false' });
        if (view) { this.disposeRuns(entry); entry.runs = []; entry.content.replaceChildren(view.element); entry.contentView = view; }
      }
      entry.contentDescriptorKey = descriptorKey;
      if (entry.contentView) { entry.content.contentEditable = 'false'; return; }
      entry.content.removeAttribute('contenteditable');
    }
    if (tag === "hr") { entry.content.contentEditable = "false"; entry.content.setAttribute("aria-label", "Separator"); return; }
    if (node.kind === "list" || node.kind === "quote") {
      if (tag === "ol" && Number.isSafeInteger(style[1])) entry.content.setAttribute("start", String(style[1]));
      else entry.content.removeAttribute("start");
      return;
    }
    if (isListItem) {
      if (node.editor?.number !== null && node.editor?.number !== undefined) entry.outer.setAttribute("value", String(node.editor.number));
      else entry.outer.removeAttribute("value");
      // A static, noneditable checklist marker; commands own toggling later.
      let marker = entry.outer.querySelector<HTMLElement>(":scope > [data-check-marker]");
      if (tuple(parent?.editor?.containerAttributes)[0] === "checklist") {
        if (!marker) { marker = this.root.ownerDocument.createElement("span"); marker.dataset.checkMarker = ""; marker.contentEditable = "false"; entry.outer.prepend(marker); }
        marker.textContent = node.editor?.checked ? "☑" : "☐";
        marker.setAttribute("role", "img"); marker.setAttribute("aria-label", node.editor?.checked ? "Checked" : "Unchecked");
      } else marker?.remove();
    }
    // Authored spacing is editor behavior, independent of the host stylesheet.
    // Keep the code block's literal, unwrapped layout; prose spaces may wrap.
    const whiteSpace = tag === "pre" ? "pre" : "break-spaces";
    if (entry.content.style.whiteSpace !== whiteSpace) entry.content.style.whiteSpace = whiteSpace;
    this.patchRuns(entry, node.runs, tag === "pre");
  }
  private arrange(): void {
    const groups = new Map<HTMLElement, HTMLElement[]>();
    for (const entry of [...this.entries.values()].sort((a, b) => a.node.order - b.node.order)) {
      const parent = this.entries.get(entry.node.parent);
      // Nested containers follow a list item's paragraph, never sit inside it.
      const target = parent ? (parent.node.kind === "block" && parent.outer !== parent.content ? parent.outer : parent.content) : this.root;
      const children = groups.get(target) ?? []; children.push(entry.outer); groups.set(target, children);
    }
    for (const [parent, children] of groups) {
      let cursor: ChildNode | null = parent.firstChild;
      for (const child of children) {
        // Skip a list item's own text and static marker when arranging nested lists.
        while (cursor && !children.includes(cursor as HTMLElement)) cursor = cursor.nextSibling;
        if (child !== cursor) parent.insertBefore(child, cursor);
        cursor = child.nextSibling;
      }
    }
  }
  private markKey(run: Run): string {
    const a = run.attributes;
    return JSON.stringify([a.bold === true, a.italic === true, a.strike === true, a.underline === true, a.code === true, this.safeHref(a.link), this.moduleKeys(run, true)]);
  }
  private moduleKeys(run: Run, identityOnly = false): Json[] {
    return Object.entries(run.attributes).filter(([key]) => key.startsWith('module:')).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => {
        try { return [key, identityOnly && Array.isArray(value) ? value[0] ?? null : value, this.modules?.resolve(key, value, run.text)?.presentation?.tag ?? null]; }
        catch { return [key, value, null]; }
      });
  }
  private safeHref(value: Json | undefined): string | null {
    if (typeof value !== "string") return null;
    try { const url = new URL(value, this.root.ownerDocument.baseURI); return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null; }
    catch { return null; }
  }
  private createRun(run: Run, code: boolean): RenderedRun {
    const element = this.root.ownerDocument.createElement("span");
    let target: HTMLElement = element;
    const views: RenderedRun['views'] = [];
    const attrs = run.attributes;
    for (const [name, tag] of [["bold", "strong"], ["italic", "em"], ["strike", "s"], ["underline", "u"], ["code", "code"]] as const) {
      if (!code && attrs[name] === true) { const wrapper = this.root.ownerDocument.createElement(tag); target.append(wrapper); target = wrapper; }
    }
    const href = code ? null : this.safeHref(attrs.link);
    if (href) { const link = this.root.ownerDocument.createElement("a"); link.href = href; link.rel = "noopener noreferrer"; target.append(link); target = link; }
    for (const [key, value] of Object.entries(attrs).filter(([k]) => k.startsWith('module:')).sort(([a], [b]) => a.localeCompare(b))) {
      // Invalid incoming/future data remains readable; no renderer can interpret
      // document strings as markup, URLs or executable behavior.
      let resolved: ReturnType<ModuleRegistry['resolve']>;
      try { resolved = this.modules?.resolve(key, value, run.text); } catch { resolved = undefined; }
      const wrapper = this.root.ownerDocument.createElement(resolved?.presentation?.tag ?? 'span');
      wrapper.dataset.moduleType = key.slice('module:'.length);
      if (!resolved?.presentation) wrapper.dataset.moduleFallback = 'text';
      if (resolved?.definition.kind === 'inline-atom' && resolved.presentation) wrapper.contentEditable = 'false';
      target.append(wrapper); target = wrapper;
      if (resolved?.presentation && this.moduleRuntime) {
        const decoration = this.root.ownerDocument.createElement('span');
        decoration.dataset.moduleView = ''; decoration.contentEditable = 'false'; wrapper.append(decoration);
        const view = this.moduleRuntime.mountView(decoration, { type: resolved.definition.type, version: resolved.definition.version,
          kind: resolved.definition.kind, text: run.text, attributes: (value as Json[])[1] as Record<string, Json> },
          () => { decoration.remove(); wrapper.dataset.moduleFallback = 'text'; });
        if (view) { this.moduleDecorations.add(decoration); views.push({ key, version: resolved.definition.version, kind: resolved.definition.kind, view }); }
        else decoration.remove();
      }
    }
    const parts = code ? [run.text] : run.text.split("\n");
    const positions: DOMPosition[] = [];
    parts.forEach((part, i) => {
      if (i) { const br = this.root.ownerDocument.createElement("br"); target.append(br); positions.push({ node: br, start: 0, length: 1 }); }
      const text = this.root.ownerDocument.createTextNode(part); target.append(text); positions.push({ node: text, start: 0, length: part.length });
    });
    return { element, text: run.text, key: this.markKey(run), contentKey: JSON.stringify(this.moduleKeys(run)), positions, views };
  }
  private disposeRuns(entry: Entry): void { entry.contentView?.dispose(); delete entry.contentView; for (const run of entry.runs) for (const owned of run.views) owned.view.dispose(); }
  private patchRuns(entry: Entry, runs: readonly Run[], code: boolean): void {
    // Empty blocks need a visible caret line; it contributes no model offset.
    const desired = runs.length ? runs : [{ text: "", attributes: {} }];
    const old = entry.runs;
    let prefix = 0, suffix = 0;
    const same = (a: RenderedRun, b: Run) => a.text === b.text && a.key === this.markKey(b) && a.contentKey === JSON.stringify(this.moduleKeys(b));
    while (prefix < old.length && prefix < desired.length && same(old[prefix]!, desired[prefix]!)) prefix++;
    while (suffix < old.length - prefix && suffix < desired.length - prefix && same(old[old.length - suffix - 1]!, desired[desired.length - suffix - 1]!)) suffix++;
    const middle: RenderedRun[] = [];
    for (let i = prefix; i < desired.length - suffix; i++) {
      const run = desired[i]!, existing = i < old.length - suffix ? old[i] : undefined;
      const parts = code ? [run.text] : run.text.split("\n");
      if (existing && existing.key === this.markKey(run) && existing.positions.length === parts.length * 2 - 1) {
        // Retain text nodes and BR atoms across edits within the same lines.
        parts.forEach((part, index) => {
          const position = existing.positions[index * 2]!, text = position.node as Text;
          if (text.data !== part) {
            let start = 0, end = 0;
            while (start < text.length && start < part.length && text.data[start] === part[start]) start++;
            while (end < text.length - start && end < part.length - start && text.data[text.length - end - 1] === part[part.length - end - 1]) end++;
            text.replaceData(start, text.length - start - end, part.slice(start, part.length - end));
          }
          position.length = part.length;
        });
        existing.text = run.text; existing.contentKey = JSON.stringify(this.moduleKeys(run));
        for (const owned of existing.views) owned.view.update({ type: owned.key.slice('module:'.length), version: owned.version,
          kind: owned.kind, text: run.text, attributes: (run.attributes[owned.key] as Json[])[1] as Record<string, Json> });
        middle.push(existing);
      } else middle.push(this.createRun(run, code));
    }
    const next = [...old.slice(0, prefix), ...middle, ...(suffix ? old.slice(old.length - suffix) : [])];
    for (const run of old) if (!next.includes(run)) { for (const owned of run.views) owned.view.dispose(); run.element.remove(); }
    let cursor: ChildNode | null = entry.content.firstChild;
    for (const run of next) { if (run.element !== cursor) entry.content.insertBefore(run.element, cursor); cursor = run.element.nextSibling; }
    // Native editing may add/remove wrappers or text siblings. Reconcile only
    // this known affected block; never leave unowned native siblings beside the
    // authoritative runs (and never scan unrelated blocks).
    for (const child of Array.from(entry.content.childNodes)) {
      if (!next.some(run => run.element === child) && !(child instanceof Element && child.matches("br[data-placeholder]"))) child.remove();
    }
    entry.runs = next;
    const placeholder = entry.content.querySelector(":scope > br[data-placeholder]");
    if (desired.every(run => run.text === "") && !code) {
      if (!placeholder) { const br = this.root.ownerDocument.createElement("br"); br.dataset.placeholder = ""; entry.content.append(br); }
    } else placeholder?.remove();
  }
}
