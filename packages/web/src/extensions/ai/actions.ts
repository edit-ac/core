import type { CommitResult, StableRange, EditorCommand, Json } from '@edit-ac/core';
import { AiHost, AiSession, captureAiTarget, AI_ACTIONS, AI_TONES, prepareAiAction, type AiActionId, type AiTone, type AiOperation, type AiRequest, type AiScope } from '@edit-ac/core/extensions';
import { SlashPresenter, type SlashContext, type SlashFactory } from '../../modules/slash.js';

export interface AiActionsOptions {
  /** Local source/output byte limits must fit the host's declared limits. */
  contextBytes: number;
  outputBytes: number;
  attached?(actions: AiActions): void;
}
type Operation = Extract<AiOperation, 'ask' | 'fill' | 'continue' | 'rewrite'>;
let sequence = 0;
const size = (text: string) => new TextEncoder().encode(text).length;
const unsafePlainText = (text: string) => /[\uFFFC\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text);

/** Optional explicit-action UI. All authoritative edits use the supplied host commit port. */
export class AiActions {
  readonly element: HTMLElement;
  readonly panel: HTMLElement;
  readonly instruction: HTMLTextAreaElement;
  readonly scope: HTMLSelectElement;
  readonly target: HTMLSelectElement;
  readonly action: HTMLSelectElement;
  readonly language: HTMLInputElement;
  readonly tone: HTMLSelectElement;
  readonly output: HTMLElement;
  readonly status: HTMLElement;
  readonly session: AiSession;
  #range: StableRange | undefined;
  #guard: ReturnType<typeof captureAiTarget> | undefined;
  #request: AiRequest | undefined;
  #watch: { dispose(): void } | undefined;
  #operation: Operation = 'ask';
  #rewriteAttributes: Readonly<Record<string, Json>> | undefined;
  #readOnly = false;
  #disposed = false;
  #id = ++sequence;
  #buttons = new Map<string, HTMLButtonElement>();
  #listeners: (() => void)[] = [];
  constructor(readonly context: SlashContext, readonly host: AiHost, readonly options: AiActionsOptions) {
    if (!Number.isSafeInteger(options.contextBytes) || options.contextBytes < 1 || options.contextBytes > 32768 ||
        !Number.isSafeInteger(options.outputBytes) || options.outputBytes < 1 || options.outputBytes > 16384) throw Error('Invalid AI limits');
    this.session = new AiSession(host);
    const doc = context.root.ownerDocument;
    this.element = doc.createElement('section'); this.element.dataset.editacUi = '';
    this.element.setAttribute('aria-label', 'AI writing');
    this.panel = doc.createElement('section'); this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'AI prompt and review');
    const button = (name: string, parent: HTMLElement, action: () => void) => {
      const b = doc.createElement('button'); b.type = 'button'; b.textContent = name;
      this.#buttons.set(name, b); parent.append(b);
      const click = () => { if (b.getAttribute('aria-disabled') === 'true') return; try { action(); } catch { this.panel.hidden = false; this.render(); this.status.textContent = 'Unavailable: select a supported paragraph target.'; } };
      b.addEventListener('click', click); this.#listeners.push(() => b.removeEventListener('click', click));
      return b;
    };
    for (const [name, operation] of [['Ask AI', 'ask'], ['Fill text', 'fill'], ['Continue writing', 'continue'], ['Ask AI about selection', 'ask'], ['Rewrite selection', 'rewrite']] as const) {
      const b = button(name, this.element, () => this.open(operation, name.endsWith('selection')));
      // Pointer activation keeps the editor selection until it has been captured.
      const down = (event: PointerEvent) => event.preventDefault(); b.addEventListener('pointerdown', down);
      this.#listeners.push(() => b.removeEventListener('pointerdown', down));
    }
    const field = <T extends HTMLElement>(name: string, input: T): T => {
      input.setAttribute('aria-label', name);
      const label = doc.createElement('label'); label.textContent = name; label.append(input); this.panel.append(label); return input;
    };
    this.action = field('Writing action', doc.createElement('select'));
    for (const action of AI_ACTIONS) { const o = doc.createElement('option'); o.value = action.id; o.textContent = action.label; this.action.append(o); }
    this.language = field('Target language', doc.createElement('input')); this.language.maxLength = 64;
    this.tone = field('Requested tone', doc.createElement('select'));
    for (const tone of AI_TONES) { const o = doc.createElement('option'); o.value = tone; o.textContent = tone; this.tone.append(o); }
    this.instruction = field('Instruction', doc.createElement('textarea')); this.instruction.maxLength = 16384;
    this.scope = field('Context scope', doc.createElement('select'));
    for (const [value, label] of [['selection', 'Selected text'], ['passage', 'Current paragraph'], ['document', 'Entire document (explicit)']]) {
      const o = doc.createElement('option'); o.value = value!; o.textContent = label!; this.scope.append(o);
    }
    this.target = field('Proposal target', doc.createElement('select'));
    for (const [value, label] of [['selection', 'Captured selection or caret'], ['block', 'Captured paragraph']]) {
      const o = doc.createElement('option'); o.value = value!; o.textContent = label!; this.target.append(o);
    }
    button('Generate', this.panel, () => { void this.generate(); });
    button('Stop', this.panel, () => { this.session.cancel(); this.render(); });
    button('Reject', this.panel, () => this.reject());
    button('Accept', this.panel, () => this.accept());
    button('Regenerate', this.panel, () => { void this.regenerate(); });
    button('Close', this.panel, () => { this.session.cancel(); this.restoreTarget(); this.release(); this.panel.hidden = true; this.render(); });
    this.status = doc.createElement('p'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite'); this.status.setAttribute('aria-atomic', 'true');
    this.output = doc.createElement('pre'); this.output.setAttribute('aria-label', 'AI answer or proposed plain text'); this.output.style.whiteSpace = 'pre-wrap'; this.output.dir = 'auto';
    this.panel.append(this.status, this.output); this.element.append(this.panel); context.root.after(this.element);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); this.session.cancel(); this.render(); } };
    this.panel.addEventListener('keydown', escape); this.#listeners.push(() => this.panel.removeEventListener('keydown', escape));
    this.render();
  }
  private release(): void {
    this.#watch?.dispose(); this.#watch = undefined;
    this.#guard?.dispose(); this.#guard = undefined;
    if (this.#range) for (const token of [this.#range.anchor, this.#range.focus]) this.context.engine.releaseAnchor(token);
    this.#range = undefined; this.#request = undefined; this.#rewriteAttributes = undefined;
  }
  open(operation: Operation, selectionOnly = false): void {
    if (this.#disposed || this.#readOnly) return;
    this.session.cancel(); this.release();
    const current = this.context.selection.retain();
    if (!current) throw Error('No captured selection');
    try {
      const e = this.context.engine, a = e.resolve(current.range.anchor), f = e.resolve(current.range.focus);
      if (a.type !== 'position' || f.type !== 'position' || a.node !== f.node || selectionOnly && a.offset === f.offset) throw Error('Unsupported target');
      this.#range = { anchor: e.importAnchor(e.exportAnchor(current.range.anchor)), focus: e.importAnchor(e.exportAnchor(current.range.focus)) };
      this.#guard = captureAiTarget(e, this.#range, [], () => this.writable());
      this.scope.value = a.offset === f.offset ? 'passage' : 'selection'; this.target.value = 'selection';
      this.watch([a.node]);
      this.#operation = operation; this.instruction.value = ''; this.panel.hidden = false;
      this.render(); this.status.textContent = hostMessage(this.host); (operation === 'rewrite' ? this.action : this.instruction).focus();
    } catch (error) { this.release(); throw error; }
    finally { current.dispose(); }
  }
  private watch(ids: string[]): void {
    this.#watch?.dispose();
    this.#watch = this.context.engine.subscribe({ type: 'nodes', ids }, patch => {
      if (patch.operation !== 'Selection' && this.session.state.status !== 'accepted') { this.session.invalidate(); this.render(); }
    });
  }
  private writable(): boolean { return !this.#disposed && !this.#readOnly && this.context.root.getAttribute('aria-readonly') !== 'true' && this.host.policy().allowRemote && !this.host.policy().protectedDocument; }
  private buildRequest(): AiRequest {
    if (!this.#range || !this.#guard?.valid()) throw Error('stale');
    const e = this.context.engine, a = e.resolve(this.#range.anchor), f = e.resolve(this.#range.focus);
    if (a.type !== 'position' || f.type !== 'position' || a.node !== f.node) throw Error('stale');
    if (this.#operation === 'rewrite') {
      const node = e.read().visible.find(node => node.id === a.node);
      if (!node) throw Error('stale');
      const prepared = prepareAiAction(this.action.value as AiActionId, node, Math.min(a.offset, f.offset), Math.max(a.offset, f.offset), { language: this.language.value, tone: this.tone.value as AiTone });
      if (size(prepared.context) > this.options.contextBytes) throw Error('context-limit');
      this.#rewriteAttributes = prepared.attributes;
      this.instruction.value = prepared.instruction;
      return { version: 1, requestId: `web-ai-${this.#id}-${++sequence}`, operation: 'rewrite', scope: prepared.scope, instruction: prepared.instruction, context: prepared.context, format: prepared.format, outputBytes: this.options.outputBytes };
    }
    const scope = this.scope.value as AiScope;
    const nodes = e.read().visible.filter(n => scope === 'document' || n.id === a.node);
    let context = '';
    for (const n of nodes) {
      if (n.kind !== 'block' || !Array.isArray(n.blockAttributes) || n.blockAttributes[0] !== 'paragraph' || n.runs.some(r => r.text.includes('\uFFFC'))) throw Error('unsupported-context');
      let text = n.runs.map(r => r.text).join('');
      if (scope === 'selection') text = text.slice(Math.min(a.offset, f.offset), Math.max(a.offset, f.offset));
      context += (context ? '\n' : '') + text;
      if (size(context) > this.options.contextBytes) throw Error('context-limit');
    }
    this.watch(nodes.map(n => n.id));
    // Freeze context ownership now; moving focus/caret never recaptures a target.
    this.#guard.dispose(); this.#guard = captureAiTarget(e, this.#range, nodes.map(n => n.id), () => this.writable());
    if (this.target.value === 'block' || this.#operation === 'continue') {
      const n = nodes.find(n => n.id === a.node)!; const end = n.runs.reduce((sum, r) => sum + r.text.length, 0);
      const replacement = { anchor: e.anchor(a.node, this.#operation === 'continue' ? end : 0, 'right'), focus: e.anchor(a.node, end, 'left') };
      for (const token of [this.#range.anchor, this.#range.focus]) e.releaseAnchor(token);
      this.#range = replacement;
    }
    return { version: 1, requestId: `web-ai-${this.#id}-${++sequence}`, operation: this.#operation, scope, instruction: this.instruction.value, context, format: 'plain-text', outputBytes: this.options.outputBytes };
  }
  async generate(): Promise<void> {
    if (this.#disposed || this.#request) return; // edits after review require a fresh explicit capture
    try { this.#request = this.buildRequest(); await this.run(); }
    catch (error) {
      if (error instanceof Error && error.message === 'stale') { this.session.invalidate(); this.render(); }
      else this.status.textContent = `Unavailable: ${error instanceof Error ? error.message : 'invalid target'}`;
    }
  }
  async regenerate(): Promise<void> {
    if (!this.#request || this.#disposed || !this.#guard?.valid()) { this.session.invalidate(); this.render(); return; }
    this.#request = { ...this.#request, requestId: `web-ai-${this.#id}-${++sequence}` }; await this.run();
  }
  private async run(): Promise<void> {
    if (!this.#request || !this.#range || !this.#guard?.valid()) { this.session.invalidate(); this.render(); return; }
    const range = this.#range, guard = this.#guard;
    const target = { valid: () => guard.valid(), dispose() {}, accept: (text: string): CommitResult => {
      if (!guard.valid()) throw Error('stale');
      const e = this.context.engine, a = e.resolve(range.anchor), f = e.resolve(range.focus);
      if (a.type !== 'position' || f.type !== 'position') throw Error('stale');
      const offset = Math.min(a.offset, f.offset) + text.length;
      if (this.#operation === 'rewrite' && unsafePlainText(text)) throw Error('unsupported-output');
      const marks: EditorCommand[] = this.#rewriteAttributes ? (['bold','italic','strike','underline','code','link'] as const).map(mark => ({
        type: 'markAt', owner: a.node, from: Math.min(a.offset, f.offset), to: offset, mark,
        action: this.#rewriteAttributes![mark] ? 'apply' : 'remove',
        ...(mark === 'link' && this.#rewriteAttributes![mark] ? { href: String(this.#rewriteAttributes![mark]) } : {}),
      })) : [];
      e.history({ type: 'boundary' });
      try { return this.context.commit({ kind: 'editor', origin: 'ai:reviewed', commands: [
        { type: 'historySelectionAt', anchor: { owner: a.node, offset: a.offset, bias: a.bias }, focus: { owner: f.node, offset: f.offset, bias: f.bias } },
        { type: 'replace', range, text },
        ...marks,
        { type: 'selectionAt', anchor: { owner: a.node, offset, bias: 'right' }, focus: { owner: a.node, offset, bias: 'left' } },
      ] }); } finally { e.history({ type: 'boundary' }); }
    } };
    const pending = this.session.start(this.#request, target); this.render(); await pending;
    if (this.#operation === 'rewrite' && this.session.state.status === 'review' && unsafePlainText(this.session.state.text)) {
      this.session.reject(); this.render(); this.status.textContent = 'Unavailable: unsupported-output (protected atom or control character).';
    } else this.render();
  }
  private restoreTarget(): void {
    const active = this.context.root.ownerDocument.activeElement;
    if (active && this.element.contains(active) && this.#range && this.#guard?.valid()) {
      this.context.root.focus(); this.context.selection.restoreRange(this.#range);
    }
  }
  reject(): void { this.session.reject(); this.restoreTarget(); this.release(); this.render(); }
  accept(): void {
    const doc = this.context.root.ownerDocument, active = doc.activeElement;
    const restore = active instanceof HTMLElement && this.element.contains(active);
    const result = this.session.accept();
    try {
      if (result && restore) {
        this.context.root.focus();
        if (result.selection) this.context.selection.restoreRange(result.selection);
        else if (result.caret) this.context.selection.move(result.caret);
      }
    } finally {
      if (result?.caret) this.context.engine.releaseAnchor(result.caret);
      if (result?.selection) for (const token of [result.selection.anchor, result.selection.focus]) this.context.engine.releaseAnchor(token);
      if (this.session.state.status === 'accepted' || this.session.state.status === 'stale') this.release();
      this.render();
    }
  }
  private render(): void {
    if (this.#disposed) return;
    const state = this.session.state, pending = state.status === 'pending' || state.status === 'streaming';
    this.output.textContent = state.text; // untrusted output is always inert plain text
    this.status.textContent = `${state.status}${state.error ? ': ' + state.error : ''}${state.status === 'review' ? this.#operation === 'ask' ? ': Answer only. Document unchanged.' : ': Review plain text before accepting.' : ''}`;
    this.panel.setAttribute('aria-busy', String(pending));
    this.#buttons.get('Accept')!.disabled = state.status !== 'review' || this.#operation === 'ask' || !this.writable();
    this.#buttons.get('Stop')!.disabled = !pending;
    this.#buttons.get('Regenerate')!.disabled = !this.#request || !this.writable();
    this.#buttons.get('Regenerate')!.setAttribute('aria-disabled', String(pending));
    // Keep the active request control focusable: native disabled would strand Escape on body.
    this.#buttons.get('Generate')!.disabled = !this.#range || !this.writable() || this.host.availability !== 'ready';
    this.#buttons.get('Generate')!.setAttribute('aria-disabled', String(!!this.#request || pending));
    for (const name of ['Ask AI', 'Fill text', 'Continue writing', 'Ask AI about selection', 'Rewrite selection']) this.#buttons.get(name)!.disabled = this.#readOnly || this.#disposed;
    for (const input of [this.action, this.language, this.tone]) input.disabled = !!this.#request || this.#operation !== 'rewrite';
    this.instruction.readOnly = this.#operation === 'rewrite';
    this.instruction.disabled = !!this.#request; this.scope.disabled = !!this.#request || this.#operation === 'rewrite'; this.target.disabled = !!this.#request || this.#operation === 'ask' || this.#operation === 'rewrite';
  }
  setReadOnly(value: boolean): void { this.#readOnly = value; if (value) { this.session.invalidate(); this.release(); } this.render(); }
  dispose(): void {
    if (this.#disposed) return; this.session.dispose(); this.release(); this.#disposed = true;
    for (const remove of this.#listeners) remove(); this.#listeners = []; this.element.remove();
  }
}
function hostMessage(host: AiHost): string { return host.availability === 'ready' ? 'Choose context and instruction. Responses are plain text. Rewrites support a paragraph selection with uniform built-in marks; mixed formatting, protected atoms and other structures are unavailable.' : 'AI unavailable. Configure a host transport, quota and limits.'; }

/** Compose with existing indexed slash dispatch and its host lifecycle. No shared input hook. */
export function aiActions(host: AiHost, options: AiActionsOptions): SlashFactory {
  return context => {
    let actions!: AiActions;
    const presenter = new SlashPresenter(context, (['ask', 'fill', 'continue', 'rewrite'] as const).map(operation => ({
      id: `ai-${operation}`, label: operation === 'ask' ? 'Ask AI' : operation === 'fill' ? 'Fill text' : operation === 'rewrite' ? 'Rewrite selection' : 'Continue writing',
      keywords: [operation, 'ai'], prepare: () => { actions.open(operation, operation === 'rewrite'); return undefined; },
    })), false);
    try { actions = new AiActions(context, host, options); options.attached?.(actions); }
    catch (error) { actions?.dispose(); presenter.dispose(); throw error; }
    const dispose = presenter.dispose.bind(presenter), readOnly = presenter.setReadOnly.bind(presenter);
    presenter.dispose = () => { actions.dispose(); dispose(); };
    presenter.setReadOnly = value => { actions.setReadOnly(value); readOnly(value); };
    return presenter;
  };
}
