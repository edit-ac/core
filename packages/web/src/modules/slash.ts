import type { CommitResult, EditorCommand, EngineHandle, FragmentBlock, PrepareRequest, ProjectedNode, StableRange } from '@edit-ac/core';
import type { DOMSelection, RetainedSelection } from '../dom/selection.js';

export type SlashAction = { type: 'fragment'; blocks: readonly FragmentBlock[] } | { type: 'editor'; commands: readonly EditorCommand[] };
export interface SlashCommand {
  id: string;
  label: string;
  keywords?: readonly string[];
  disabled?: string;
  /** Prepare only. The presenter owns validation, mutation and history. */
  prepare(context: Readonly<{ query: string; node: string; signal: AbortSignal }>): SlashAction | undefined | Promise<SlashAction | undefined>;
}
export interface SlashContext {
  root: HTMLElement;
  engine: EngineHandle;
  selection: DOMSelection;
  commit(request: PrepareRequest): CommitResult;
  route(event: Event): void;
  focusEscape(event: KeyboardEvent): void;
}
export type SlashFactory = (context: SlashContext) => SlashPresenter;
interface RegisteredSlashCommand extends SlashCommand { readonly searchTerms: readonly string[] }
interface Session { node: string; range: StableRange; query: string; generation: number }
let sequence = 0;

/** Host registrations are frozen before mount; callbacks never enter documents.
 * Import this factory only in configurations that enable the slash presenter. */
export function slashCommands(commands: readonly SlashCommand[], options: { literal?: boolean } = {}): SlashFactory {
  if (commands.length > 500) throw Error('Too many slash commands');
  const ids = new Set<string>();
  const registered = commands.map(command => {
    if (!/^[a-zA-Z][\w.-]{0,63}$/.test(command.id) || ids.has(command.id) || !command.label || command.label.length > 128 || typeof command.prepare !== 'function' ||
        (command.disabled !== undefined && (!command.disabled || command.disabled.length > 256)) || (command.keywords?.length ?? 0) > 16 || command.keywords?.some(k => k.length > 64)) throw Error('Invalid slash command');
    ids.add(command.id);
    return Object.freeze({ ...command, keywords: Object.freeze([...(command.keywords ?? [])]) });
  });
  return context => new SlashPresenter(context, registered, options.literal ?? false);
}

/** Bounded local query plus a relative range, never a second writable model. */
export class SlashPresenter {
  readonly menu: HTMLElement;
  private readonly status: HTMLElement;
  private readonly control: HTMLButtonElement;
  private session: Session | undefined;
  private results: readonly SlashCommand[] = [];
  private active = -1;
  private generation = 0;
  private disposed = false;
  private readOnly = false;
  private pending: AbortController | undefined;
  private explicitTarget: RetainedSelection | undefined;
  private readonly subscription;
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  private readonly nodes = new Map<string, ProjectedNode>();
  private readonly previous: Record<string, string | null>;
  private readonly commands: readonly RegisteredSlashCommand[];
  constructor(private readonly context: SlashContext, commands: readonly SlashCommand[], private readonly literal: boolean) {
    if (commands.length > 500) throw Error('Too many slash commands');
    this.commands = commands.map(command => Object.freeze({ ...command, keywords: Object.freeze([...(command.keywords ?? [])]),
      searchTerms: Object.freeze([command.label, ...(command.keywords ?? [])].map(word => word.toLocaleLowerCase())) }));
    const { root, engine } = context, doc = root.ownerDocument;
    this.menu = doc.createElement('div'); this.menu.id = `editac-slash-${++sequence}`;
    this.menu.setAttribute('role', 'menu'); this.menu.setAttribute('aria-label', 'Slash commands'); this.menu.hidden = true;
    this.status = doc.createElement('div'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.control = doc.createElement('button'); this.control.type = 'button'; this.control.tabIndex = 0; this.control.textContent = 'Slash commands';
    this.control.setAttribute('aria-haspopup', 'menu'); this.control.setAttribute('aria-controls', this.menu.id); this.control.setAttribute('aria-expanded', 'false');
    for (const element of [this.menu, this.control, this.status]) element.dataset.editacUi = '';
    this.status.setAttribute('aria-atomic', 'true');
    root.after(this.control, this.menu, this.status);
    this.previous = Object.fromEntries(['aria-haspopup', 'aria-controls', 'aria-expanded'].map(key => [key, root.getAttribute(key)]));
    root.setAttribute('aria-haspopup', 'menu'); root.setAttribute('aria-controls', this.menu.id); root.setAttribute('aria-expanded', 'false');
    this.listen(doc, 'focusin', () => { if (!this.inside(doc.activeElement)) { this.clearTarget(); this.dismiss(); } });
    this.listen(root, 'focusout', () => queueMicrotask(() => { if (this.session && !this.inside(doc.activeElement)) this.dismiss(); }));
    this.listen(doc, 'selectionchange', () => { if (this.session && !this.menu.contains(doc.activeElement)) this.refresh(); });
    this.listen(this.menu, 'pointerdown', event => {
      const item = (event.target as Element).closest<HTMLElement>('[role="menuitem"]');
      if (!item) return;
      this.focusPointer(event, item);
    });
    this.listen(this.menu, 'click', event => {
      const item = (event.target as Element).closest<HTMLElement>('[data-command]');
      if (item) void this.activate(item.dataset.command!);
    });
    this.listen(this.menu, 'focusin', event => {
      const id = (event.target as HTMLElement).dataset.command;
      const index = this.results.findIndex(command => command.id === id);
      if (index >= 0) { this.active = this.results[index]!.disabled ? -1 : index; this.updateActive(); }
    });
    this.listen(this.menu, 'keydown', event => {
      if (!this.handle(event)) {
        const key = event as KeyboardEvent;
        if (key.defaultPrevented || key.isComposing || key.getModifierState('AltGraph') || ['Dead', 'Process'].includes(key.key)) return;
        this.restoreFocus(); this.context.route(event);
      }
    });
    // Explicit command access remains available when typing provenance is absent.
    this.listen(this.control, 'pointerdown', event => { this.captureTarget(); this.focusPointer(event, this.control); });
    this.listen(this.control, 'click', () => { this.openExplicit(); if (this.session) this.focusActive(); });
    for (const node of engine.read().visible) this.nodes.set(node.id, node);
    this.subscription = engine.subscribe({ type: 'all' }, patch => {
      for (const change of patch.nodes) {
        if (change.type === 'visible') this.nodes.set(change.node.id, change.node);
        else this.nodes.delete(change.type === 'removed' ? change.id : change.node.id);
      }
      if (!this.session) return;
      if (patch.operation === 'Remote') this.dismiss();
      else queueMicrotask(() => this.refresh());
    });
  }
  private focusPointer(event: Event, target: HTMLElement): void {
    // WebKit touch needs its native compatibility click. Keep focus inside
    // the composite explicitly, including hosts where tapping does not focus buttons.
    if ((event as PointerEvent).pointerType === 'touch') target.focus({ preventScroll: true });
    else event.preventDefault();
  }
  private listen(target: EventTarget, type: string, listener: EventListener): void { target.addEventListener(type, listener); this.listeners.push([target, type, listener]); }
  private inside(target: Element | null): boolean {
    if (!target) return false;
    const root = this.context.root;
    if (root.contains(target) || this.menu.contains(target) || target === this.control) return true;
    // A named host toolbar can share the captured command target. Native text
    // controls still own their input and cannot keep an editor popup alive.
    if (target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]')) return false;
    const toolbar = target.closest('[role="toolbar"]');
    return !!root.id && !!toolbar?.getAttribute('aria-controls')?.split(/\s+/u).includes(root.id);
  }
  get open(): boolean { return !!this.session; }
  get query(): string | undefined { return this.session?.query; }
  private eligible(node: ProjectedNode, offset: number): boolean {
    if (this.literal || !Array.isArray(node.blockAttributes) || !['paragraph', 'heading'].includes(String(node.blockAttributes[0]))) return false;
    let start = 0;
    for (const run of node.runs) {
      const end = start + run.text.length;
      if (offset >= start && offset <= end && (run.attributes.code || run.attributes.link || Object.keys(run.attributes).some(k => k.startsWith('module:')))) return false;
      start = end;
    }
    return true;
  }
  eligibleAt(nodeId: string, offset: number): boolean {
    const node = this.nodes.get(nodeId); return !!node && this.eligible(node, offset);
  }
  /** Called only after the input owner's successful, correlated direct typing. */
  typed(nodeId: string, offset: number, text: string, eligible: boolean): void {
    if (this.session) { this.refresh(); return; }
    if (!eligible || text !== '/' || this.disposed || this.readOnly) return;
    const node = this.nodes.get(nodeId);
    const source = node?.runs.map(r => r.text).join('');
    if (!node || source === undefined || !this.eligible(node, offset) || source[offset] !== '/' || (offset > 0 && !/\s/u.test(source[offset - 1]!))) return;
    this.openRange(nodeId, offset, offset + 1, '');
  }
  private openRange(node: string, start: number, end: number, query: string): void {
    const engine = this.context.engine, anchor = engine.anchor(node, start, 'right');
    try { this.session = { node, range: { anchor, focus: engine.anchor(node, end, 'right') }, query, generation: ++this.generation }; }
    catch (error) { engine.releaseAnchor(anchor); throw error; }
    this.render();
  }
  private clearTarget(): void { this.explicitTarget?.dispose(); this.explicitTarget = undefined; }
  private captureTarget(): void { this.clearTarget(); this.explicitTarget = this.context.selection.retain(); }
  /** Visible control accepts an existing literal /query; it never fabricates text. */
  openExplicit(): void {
    if (this.disposed || this.readOnly || this.session) return;
    const target = this.explicitTarget ?? this.context.selection.retain(); this.explicitTarget = undefined;
    try {
      if (!target) return;
      const a = this.context.engine.resolve(target.range.anchor), b = this.context.engine.resolve(target.range.focus);
      if (a.type !== 'position' || b.type !== 'position' || a.node !== b.node || a.offset !== b.offset) return;
      const node = this.nodes.get(a.node), source = node?.runs.map(r => r.text).join('') ?? '';
      const match = /(?:^|\s)(\/[^\s/]{0,64})$/.exec(source.slice(Math.max(0, a.offset - 66), a.offset));
      if (!node || !match || !this.eligible(node, a.offset)) return;
      this.openRange(a.node, a.offset - match[1]!.length, a.offset, match[1]!.slice(1));
    } finally { target?.dispose(); }
  }
  private current(checkCaret = true): { session: Session; query: string } | undefined {
    const session = this.session; if (!session || this.readOnly || this.disposed) return;
    const { engine, selection } = this.context, a = engine.resolve(session.range.anchor), b = engine.resolve(session.range.focus);
    if (a.type !== 'position' || b.type !== 'position' || a.node !== session.node || b.node !== a.node || b.offset < a.offset || b.offset - a.offset > 65) return;
    const node = this.nodes.get(a.node), source = node?.runs.map(r => r.text).join('') ?? '', query = source.slice(a.offset, b.offset);
    if (!node || !this.eligible(node, a.offset) || (a.offset > 0 && !/\s/u.test(source[a.offset - 1]!)) || !/^\/[^\s/]{0,64}$/u.test(query)) return;
    if (checkCaret && !this.menu.contains(this.context.root.ownerDocument.activeElement) && this.context.root.ownerDocument.activeElement !== this.control) {
      const target = selection.retain();
      try {
        if (!target) return;
        const p = engine.resolve(target.range.anchor), q = engine.resolve(target.range.focus);
        if (p.type !== 'position' || q.type !== 'position' || p.node !== a.node || q.node !== a.node || p.offset !== q.offset || p.offset < a.offset + 1 || p.offset > b.offset) return;
      } finally { target?.dispose(); }
    }
    return { session, query: query.slice(1) };
  }
  private refresh(): void {
    if (!this.session) return;
    const current = this.current();
    if (!current) { this.dismiss(); return; }
    if (current.query !== current.session.query) {
      this.pending?.abort(); this.pending = undefined;
      current.session.query = current.query; current.session.generation = ++this.generation; this.render();
    }
  }
  private render(): void {
    const query = this.session!.query.toLocaleLowerCase();
    this.results = this.commands.filter(command => command.searchTerms.some(word => word.includes(query)));
    this.active = this.results.findIndex(command => !command.disabled);
    const doc = this.menu.ownerDocument;
    this.menu.replaceChildren(...this.results.map((command, index) => {
      const item = doc.createElement('button'); item.type = 'button'; item.textContent = command.label; item.setAttribute('role', 'menuitem');
      item.dataset.command = command.id; item.tabIndex = index === this.active ? 0 : -1;
      item.setAttribute('aria-disabled', String(!!command.disabled)); if (command.disabled) item.title = command.disabled;
      return item;
    }));
    this.menu.hidden = false; this.context.root.setAttribute('aria-expanded', 'true'); this.control.setAttribute('aria-expanded', 'true');
    this.updateActive();
  }
  private announce(): void {
    const text = Array.from(`${this.results.length} slash commands. ${this.active >= 0 ? this.results[this.active]!.label : 'No enabled command'}.`).slice(0, 240).join('');
    if (this.status.textContent !== text) this.status.textContent = text;
  }
  private updateActive(): void {
    [...this.menu.children].forEach((item, index) => { (item as HTMLElement).tabIndex = index === this.active ? 0 : -1; item.setAttribute('data-active', String(index === this.active)); });
    this.announce();
  }
  private focusActive(): void {
    this.updateActive();
    (this.menu.children[this.active] as HTMLElement | undefined)?.focus();
  }
  handle(event: Event): boolean {
    if (event.defaultPrevented) return false;
    if (event.type === 'keydown') {
      if ((event as KeyboardEvent).key === 'Tab') this.captureTarget(); else this.clearTarget();
    }
    if (event.type === 'compositionstart') { this.dismiss(); return false; }
    if (event.type === 'paste' || event.type === 'cut' || event.type === 'beforeinput' && ['insertFromPaste', 'insertReplacementText'].includes((event as InputEvent).inputType)) { this.dismiss(); return false; }
    if (!this.session || event.type !== 'keydown') return false;
    const key = event as KeyboardEvent;
    if (key.isComposing || key.key === 'Process' || key.key === 'Dead' || key.ctrlKey || key.metaKey || key.altKey || key.getModifierState('AltGraph')) return false;
    if (key.key === 'Tab') { this.dismiss(true); return false; }
    if (key.key === 'Escape') { this.dismiss(true); this.context.focusEscape(key); event.preventDefault(); return true; }
    if (key.key === 'Enter' && key.shiftKey) { this.dismiss(true); return false; }
    if (key.key === 'Enter') { event.preventDefault(); if (this.active >= 0) void this.activate(this.results[this.active]!.id); return true; }
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key.key)) {
      event.preventDefault(); const enabled = this.results.map((command, index) => command.disabled ? -1 : index).filter(index => index >= 0);
      if (enabled.length) {
        const index = enabled.indexOf(this.active);
        this.active = key.key === 'Home' ? enabled[0]! : key.key === 'End' ? enabled.at(-1)! : index < 0 ? (key.key === 'ArrowUp' ? enabled.at(-1)! : enabled[0]!) : enabled[(index + (key.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length]!;
        this.focusActive();
      }
      return true;
    }
    return false;
  }
  async activate(id: string): Promise<void> {
    if (this.pending) return;
    const current = this.current(), command = this.results.find(command => command.id === id);
    if (!current || current.query !== current.session.query || !command || command.disabled) return;
    const session = current.session, generation = session.generation, controller = new AbortController(); this.pending = controller;
    try {
      const action = await command.prepare(Object.freeze({ query: session.query, node: session.node, signal: controller.signal }));
      const now = this.current();
      if (!action || controller.signal.aborted || now?.session !== session || now.query !== session.query || generation !== session.generation) return;
      const request: PrepareRequest = action.type === 'fragment' ? { kind: 'fragment', origin: `slash:${command.id}`, range: session.range, blocks: action.blocks } :
        { kind: 'editor', origin: `slash:${command.id}`, commands: [{ type: 'delete', range: session.range }, ...action.commands] };
      if (!this.context.engine.can(request)) { this.status.textContent = 'Slash command unavailable. Query retained.'; return; }
      this.context.engine.history({ type: 'boundary' }); this.context.engine.history({ type: 'explicit' });
      let result: CommitResult;
      try { result = this.context.commit(request); }
      finally { this.context.engine.history({ type: 'boundary' }); }
      const fallback = this.context.engine.resolve(session.range.focus);
      this.dismiss(); this.context.root.focus();
      try {
        if (result.selection) this.context.selection.restoreRange(result.selection);
        else if (result.caret) this.context.selection.move(result.caret);
        else if (fallback.type === 'position') this.placeCaret(fallback);
      } finally {
        if (result.caret) this.context.engine.releaseAnchor(result.caret);
        if (result.selection) {
          this.context.engine.releaseAnchor(result.selection.anchor);
          this.context.engine.releaseAnchor(result.selection.focus);
        }
      }
      this.context.selection.capture();
    } catch { if (!controller.signal.aborted && this.session === session) this.status.textContent = 'Slash command failed. Query retained.'; }
    finally { if (this.pending === controller) this.pending = undefined; }
  }
  private placeCaret(point: { node: string; offset: number; bias: 'left' | 'right' }): void {
    const dom = this.context.selection.toDOM(point);
    if (dom) this.context.root.ownerDocument.getSelection()?.setBaseAndExtent(dom.node, dom.offset, dom.node, dom.offset);
    this.context.selection.capture();
  }
  private restoreFocus(): void {
    this.context.root.focus();
    if (this.session) { const point = this.context.engine.resolve(this.session.range.focus); if (point.type === 'position') this.placeCaret(point); }
    else this.context.selection.restore();
  }
  dismiss(restore = false): void {
    const session = this.session; if (restore && session) this.restoreFocus(); this.session = undefined; this.pending?.abort(); this.pending = undefined; this.generation++;
    if (session) { this.context.engine.releaseAnchor(session.range.anchor); this.context.engine.releaseAnchor(session.range.focus); }
    this.menu.hidden = true; this.menu.replaceChildren(); this.results = []; this.active = -1;
    this.context.root.setAttribute('aria-expanded', 'false'); this.control.setAttribute('aria-expanded', 'false'); this.status.textContent = '';
  }
  setReadOnly(value: boolean): void { this.readOnly = value; this.control.disabled = value; if (value) { this.clearTarget(); this.dismiss(); } }
  dispose(): void {
    if (this.disposed) return; this.clearTarget(); this.dismiss(); this.disposed = true; this.subscription.dispose();
    for (const [target, type, listener] of this.listeners) target.removeEventListener(type, listener);
    this.nodes.clear(); this.listeners.length = 0; this.menu.remove(); this.control.remove(); this.status.remove();
    for (const [key, value] of Object.entries(this.previous)) { if (value === null) this.context.root.removeAttribute(key); else this.context.root.setAttribute(key, value); }
  }
}
