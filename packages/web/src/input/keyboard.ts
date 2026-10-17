import { commandCatalog, resolveCommand, shortcutCommand, type ShortcutProfile, type CapturedCommand, type PortableCommand } from '../commands/catalog.js';
import { FormattingInput, type ToolbarTarget } from '../commands/formatting.js';
export type { ToolbarTarget } from '../commands/formatting.js';
export interface HistoryTarget {
  readonly active: boolean;
  execute(action: 'undo' | 'redo'): CommandResult;
  dispose(): void;
}
import { leaveEditor } from './focus.js';
import { errorMessage, rejected } from '../errors.js';
import type { AnchorToken, CommitResult, EditorCommand, EngineHandle, PrepareRequest, ProjectedNode, StableRange } from '@edit-ac/core';
import type { DOMRenderer } from '../dom/render.js';
import type { DOMSelection, RetainedSelection } from '../dom/selection.js';

export type KeyboardAction = 'enter' | 'break' | 'backward' | 'forward' | 'indent' | 'outdent' | 'undo' | 'redo' | 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link';
export interface CommandResult { disposition: 'committed' | 'handled' | 'rejected'; reason?: string }
const kind = (node: ProjectedNode) => Array.isArray(node.blockAttributes) ? node.blockAttributes[0] : undefined;
const length = (node: ProjectedNode) => node.runs.reduce((n, run) => n + run.text.length, 0);

/** Called only after the sole input owner has resolved composition precedence.
 * All content changes are applicability-checked prepared engine transactions.
 * Native visual navigation and platform word/line ranges stay browser-owned.
 */
export class KeyboardInput {
  #disposed = false;
  #profile: ShortcutProfile = {};
  #allowed: (command: PortableCommand) => boolean = () => true;
  readonly #commandTargets = new Set<CapturedCommand>();
  #escape = false;
  #sequence = 0;
  readonly #help: HTMLElement;
  #link: { element: HTMLElement; target: ToolbarTarget; selection: RetainedSelection } | undefined;
  readonly #description: string | null;
  static #helpId = 0;
  readonly formatting: FormattingInput;
  readonly #historyTargets = new Set<HistoryTarget>();
  readonly #renderer: DOMRenderer;
  readonly #selection: DOMSelection;
  readonly #engine: EngineHandle;
  readonly #commit: (request: PrepareRequest) => CommitResult;
  readonly #blocked: () => boolean;
  constructor(renderer: DOMRenderer, selection: DOMSelection,
    engine: EngineHandle, commit: (request: PrepareRequest) => CommitResult,
    blocked: () => boolean) {
    this.#renderer = renderer;
    this.#selection = selection;
    this.#engine = engine;
    this.#commit = commit;
    this.#blocked = blocked;
    this.formatting = new FormattingInput(renderer, selection, engine, commit, blocked, mark => this.#allowed(mark), node => this.#link?.element.contains(node) ?? false);
    const root = renderer.root, doc = root.ownerDocument;
    this.#help = doc.createElement('p');
    this.#help.dataset.editacUi = '';
    this.#help.id = `editac-keyboard-help-${++KeyboardInput.#helpId}`;
    this.#help.textContent = 'Keyboard help: Tab moves focus in prose, indents lists/code and moves table cells. Shift+Tab reverses; Escape then Tab leaves the editor. Primary+B/I/U formats; Primary+K edits a link; Primary+Z/Shift+Z undoes/redoes. Browser and system shortcuts remain available.';
    this.#description = root.getAttribute('aria-describedby');
    root.setAttribute('aria-describedby', [this.#description, this.#help.id].filter(Boolean).join(' '));
    root.after(this.#help);
  }

  action(event: Event): KeyboardAction | undefined {
    if (event.defaultPrevented) {
      if (event.type === 'keydown' || event.type === 'beforeinput') this.resetFocusEscape();
      return undefined;
    }
    if (event.type === 'beforeinput') {
      this.resetFocusEscape();
      const command = resolveCommand((event as InputEvent).inputType);
      return command === 'replace' ? undefined : command;
    }
    if (event.type !== 'keydown') return undefined;
    const key = event as KeyboardEvent;
    // Shift arrives before Tab on native keyboards. Modifier-only keydowns do
    // not perform an edit/navigation intent or consume the armed focus escape.
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(key.key)) return undefined;
    // Escape is a one-shot focus route. Every other edit/navigation intent,
    // including modifier shortcuts which remain native, invalidates it.
    const escape = this.#escape;
    this.resetFocusEscape();
    if (key.isComposing || key.key === 'Dead' || key.key === 'Process' || key.getModifierState('AltGraph') || key.altKey) return undefined;
    const mac = /Mac|iPhone|iPad/.test(this.#renderer.root.ownerDocument.defaultView?.navigator.platform ?? '');
    const primary = mac ? key.metaKey && !key.ctrlKey : key.ctrlKey && !key.metaKey;
    const chord = `${primary ? 'Primary+' : ''}${key.shiftKey ? 'Shift+' : ''}${key.key.length === 1 ? key.key.toLowerCase() : key.key}`;
    if (primary) {
      const command = shortcutCommand(chord, this.#profile, !mac);
      if (command && !this.#allowed(command)) return command;
      if (command === 'bold' || command === 'italic' || command === 'underline' || command === 'link') {
        const target = this.formatting.capture();
        try { return target && target.state(command) !== 'disabled' ? command : undefined; }
        finally { target?.dispose(); }
      }
      return command;
    }
    // Reserved/remapped unmodified editing keys also remain with their owner.
    if (this.#profile.reserved?.includes(chord)) return undefined;
    if (Object.hasOwn(this.#profile.remap ?? {}, chord)) return shortcutCommand(chord, this.#profile);
    if (key.ctrlKey || key.metaKey) return undefined;
    if (key.key === 'Escape') { if (this.#link) { this.#closeLink(true); key.preventDefault(); } this.#escape = true; return undefined; }
    if (key.key === 'Tab' && escape) { if (leaveEditor(this.#renderer.root, key.shiftKey)) key.preventDefault(); return undefined; }
    if (key.key === 'Tab') {
      // Read-only content still participates in keyboard focus traversal.
      // It cannot dispatch indentation and then swallow Tab as a rejected edit.
      if (this.#blocked()) { if (leaveEditor(this.#renderer.root, key.shiftKey)) key.preventDefault(); return undefined; }
      return shortcutCommand(chord, this.#profile);
    }
    return shortcutCommand(chord, this.#profile);
  }

  /** Only scoped Select All needs adapter ownership; visual movement stays native. */
  navigate(key: KeyboardEvent): boolean {
    const mac = /Mac|iPhone|iPad/.test(this.#renderer.root.ownerDocument.defaultView?.navigator.platform ?? '');
    const primary = mac ? key.metaKey && !key.ctrlKey : key.ctrlKey && !key.metaKey;
    if (this.#disposed || key.defaultPrevented || key.isComposing || key.altKey || key.shiftKey || key.getModifierState('AltGraph') || !primary || key.key.toLowerCase() !== 'a') return false;
    this.resetFocusEscape();
    if (this.#profile.reserved?.includes('Primary+a') || Object.hasOwn(this.#profile.remap ?? {}, 'Primary+a')) return false;
    return this.#selection.selectAll();
  }

  configureCommands(profile: ShortcutProfile = {}, allowed: (command: PortableCommand) => boolean = () => true): void {
    this.#profile = { reserved: [...(profile.reserved ?? [])], remap: { ...(profile.remap ?? {}) } };
    this.#allowed = allowed;
  }
  get commands() { return commandCatalog; }

  /** Capture while the editor owns focus. Supplied anchors are copied and owned
   * here; invalid targets never fall back to the current native caret. */
  captureCommand(name: string, supplied?: StableRange, focusOwner?: HTMLElement): CapturedCommand | undefined {
    const action = resolveCommand(name), root = this.#renderer.root, doc = root.ownerDocument;
    if (!action || this.#disposed || this.#blocked() || !this.#allowed(action) || doc.activeElement !== root) return undefined;
    let range: StableRange;
    const tokens: AnchorToken[] = [];
    try {
      if (!supplied) this.#selection.capture();
      const current = supplied ?? this.#selection.current?.range;
      if (!current) return undefined;
      const a = this.#engine.resolve(current.anchor), b = this.#engine.resolve(current.focus);
      if (a.type !== 'position' || b.type !== 'position' || !this.#selection.toDOM(a) || !this.#selection.toDOM(b)) return undefined;
      tokens.push(this.#engine.anchor(a.node, a.offset, a.bias));
      tokens.push(this.#engine.anchor(b.node, b.offset, b.bias));
      range = { anchor: tokens[0]!, focus: tokens[1]! };
    } catch { for (const token of tokens) this.#engine.releaseAnchor(token); return undefined; }
    const revision = this.#engine.read().revision;
    let disposed = false, redirected = false, consumed = false;
    const focus = (event: FocusEvent) => {
      const node = event.target;
      if (node instanceof Element && node !== root && !root.contains(node) && !focusOwner?.contains(node) &&
        (focusOwner || node.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))) redirected = true;
    };
    doc.addEventListener('focusin', focus);
    const valid = () => !disposed && !consumed && !redirected && !this.#disposed && !this.#blocked() && this.#allowed(action) && this.#engine.read().revision === revision;
    const target: CapturedCommand = {
      get active() { return valid(); },
      execute: text => {
        if (!valid()) return rejected('stale-or-unavailable-command-target');
        consumed = true;
        if (action !== 'replace') { root.focus(); if (doc.activeElement !== root) return rejected('editor-focus-declined'); this.#selection.restoreRange(range); return this.execute(action) ?? rejected('native-command-owner'); }
        if (typeof text !== 'string') return rejected('replacement-text-required');
        const request = this.formatting.replacement(range, text, `command:replace:${++this.#sequence}`);
        try {
          if (!this.#engine.can(request)) return rejected('inapplicable-command');
          const before = this.#engine.read().revision;
          this.#engine.history({ type: 'explicit' });
          const result = this.#commit(request); root.focus();
          try {
            if (result.selection) this.#selection.restoreRange(result.selection);
            else if (result.caret) this.#selection.move(result.caret);
            else this.#selection.restore();
          } finally {
            if (result.selection) { this.#engine.releaseAnchor(result.selection.anchor); this.#engine.releaseAnchor(result.selection.focus); }
            if (result.caret) this.#engine.releaseAnchor(result.caret);
          }
          this.formatting.reset();
          return { disposition: before === this.#engine.read().revision ? 'handled' : 'committed' };
        } catch (error) { return rejected(errorMessage(error)); }
        finally { this.#engine.history({ type: 'boundary' }); }
      },
      dispose: () => {
        if (disposed) return; disposed = true; doc.removeEventListener('focusin', focus);
        for (const token of tokens) this.#engine.releaseAnchor(token);
        this.#commandTargets.delete(target);
      },
    };
    this.#commandTargets.add(target); return target;
  }

  resetFocusEscape(): void { this.#escape = false; }

  /** Capture before a host menu takes focus; never redirect a delayed intent. */
  captureHistory(): HistoryTarget | undefined {
    if (this.#disposed || this.#blocked() || this.#renderer.root.ownerDocument.activeElement !== this.#renderer.root) return undefined;
    const selection = this.#selection.retain(); if (!selection) return undefined;
    const root = this.#renderer.root, doc = root.ownerDocument;
    let revision = this.#engine.read().revision, disposed = false, redirected = false;
    const focus = (event: FocusEvent): void => {
      const node = event.target;
      if (node instanceof Element && node !== root && node.closest('[contenteditable="true"], [role="textbox"], input, textarea, select')) redirected = true;
    };
    doc.addEventListener('focusin', focus);
    const valid = () => !disposed && !redirected && !this.#disposed && !this.#blocked() && selection.active && this.#engine.read().revision === revision;
    const target: HistoryTarget = {
      get active() { return valid(); },
      execute: action => {
        if (!valid()) return rejected('stale-or-unavailable-history-target');
        if (action !== 'undo' && action !== 'redo') return rejected('invalid-history-action');
        if (!this.#allowed(action)) return rejected('command-permission-denied');
        root.focus(); this.#selection.restoreRetained(selection);
        const result = this.execute(action)!; revision = this.#engine.read().revision;
        return result;
      },
      dispose: () => {
        if (disposed) return; disposed = true;
        doc.removeEventListener('focusin', focus); selection.dispose(); this.#historyTargets.delete(target);
      },
    };
    this.#historyTargets.add(target); return target;
  }

  /** Undefined means native ownership: do not prevent the event. */
  execute(action: KeyboardAction, origin = `keyboard:${++this.#sequence}`): CommandResult | undefined {
    this.resetFocusEscape();
    if (this.#disposed || this.#blocked()) return rejected(this.#disposed ? 'disposed' : 'read-only-or-composing');
    if (!this.#allowed(action)) return rejected('command-permission-denied');
    if (action === 'link') return this.openLink();
    const selectedNode = (action === 'backward' || action === 'forward') && this.#selection.selectedNode();
    if (selectedNode) {
      let at: AnchorToken | undefined, caret: AnchorToken | undefined, selection: StableRange | undefined, started = false;
      try {
        const node = this.#engine.read().visible.find(n => n.id === selectedNode);
        if (!node) return rejected('stale-target');
        const descriptor = node.blockAttributes;
        const content = Array.isArray(descriptor) && typeof descriptor[0] === 'string' && descriptor[0].startsWith('module:');
        const commands: EditorCommand[] = [];
        if (content) {
          at = this.#engine.anchor(selectedNode, 0, 'right');
          const point = { owner: selectedNode, offset: 0, bias: 'right' as const };
          commands.push({ type: 'historySelectionAt', anchor: point, focus: point },
            { type: 'atomicContent', owner: selectedNode, expected: descriptor, at, replacement: null },
            { type: 'selectionAt', anchor: point, focus: point });
        } else commands.push({ type: 'deleteSeparator', owner: selectedNode });
        const request: PrepareRequest = { kind: 'editor', origin, commands };
        if (!this.#engine.can(request)) return rejected('inapplicable-command');
        this.#engine.history({ type: 'explicit' }); started = true;
        const result = this.#commit(request); caret = result.caret; selection = result.selection;
        if (selection) this.#selection.restoreRange(selection);
        else if (caret) this.#move(caret);
        return { disposition: 'committed' };
      } catch (error) { return rejected(errorMessage(error)); }
      finally {
        if (at) this.#engine.releaseAnchor(at);
        if (caret) this.#engine.releaseAnchor(caret);
        if (selection) { this.#engine.releaseAnchor(selection.anchor); this.#engine.releaseAnchor(selection.focus); }
        if (started) this.#engine.history({ type: 'boundary' });
      }
    }
    if (action === 'bold' || action === 'italic' || action === 'underline' || action === 'strike' || action === 'code') {
      const target = this.captureToolbar(); if (!target) return rejected('unmapped-selection');
      try { return target.format(action); } finally { target.dispose(); this.#engine.history({ type: 'boundary' }); }
    }
    if (action === 'undo' || action === 'redo') {
      this.#engine.history({ type: 'boundary' });
      const before = this.#engine.read().revision;
      const pending = this.#selection.current && this.formatting.typing(this.#selection.current.range);
      const result = this.#engine.history({ type: action });
      if (result.selection) {
        const selection = result.selection;
        try {
          this.#selection.restoreRange(selection);
        } finally {
          this.#engine.releaseAnchor(selection.anchor);
          this.#engine.releaseAnchor(selection.focus);
        }
      } else this.#selection.restore();
      if (before !== this.#engine.read().revision && pending) this.formatting.remember(pending);
      return { disposition: before === this.#engine.read().revision ? 'handled' : 'committed' };
    }
    if (action === 'enter' || action === 'backward' || action === 'forward') {
      // A native block-end point must stay on that owner when adjacent split
      // blocks share a source cut. Keep starts right-affine and ends left-affine
      // while capturing this synchronous structural intent; engine routing stays
      // unchanged, and the command's output caret is a separate token.
      const native = this.#renderer.root.ownerDocument.getSelection();
      if (native?.anchorNode && native.focusNode) {
        const nodes = this.#engine.read().visible;
        const bias = (node: Node, offset: number): 'left' | 'right' => {
          const point = this.#selection.toModel(node, offset);
          const owner = nodes.find(n => n.id === point?.node);
          return point && owner && point.offset > 0 && point.offset === length(owner) ? 'left' : 'right';
        };
        this.#selection.capture({ anchor: bias(native.anchorNode, native.anchorOffset), focus: bias(native.focusNode, native.focusOffset) });
      }
    }
    if ((action === 'backward' || action === 'forward') && this.#selection.selectAdjacentAtom(action === 'backward')) return { disposition: 'handled' };
    const target = this.#selection.retain();
    if (!target) return rejected('unmapped-selection');
    const tokens: AnchorToken[] = [];
    const anchor = (id: string, offset: number, bias: 'left' | 'right' = 'right') => {
      const token = this.#engine.anchor(id, offset, bias); tokens.push(token); return token;
    };
    try {
      const a = this.#engine.resolve(target.range.anchor), b = this.#engine.resolve(target.range.focus);
      if (a.type !== 'position' || b.type !== 'position') return rejected('stale-target');
      const nodes = this.#engine.read().visible.filter(n => n.kind === 'block');
      const ai = nodes.findIndex(n => n.id === a.node), bi = nodes.findIndex(n => n.id === b.node);
      if (ai < 0 || bi < 0) return rejected('unsupported-target');
      const forward = ai < bi || ai === bi && a.offset <= b.offset;
      const start = forward ? a : b, end = forward ? b : a, si = Math.min(ai, bi), ei = Math.max(ai, bi);
      const node = nodes[si]!, collapsed = si === ei && start.offset === end.offset;
      if (!collapsed && si !== ei && (action === 'backward' || action === 'forward')) {
        const request: PrepareRequest = { kind: 'fragment', origin, range: target.range, blocks: [{ attributes: null, runs: [] }] };
        if (!this.#engine.can(request)) return rejected('inapplicable-command');
        this.#engine.history({ type: 'explicit' });
        try {
          const result = this.#commit(request);
          if (result.caret) { tokens.push(result.caret); this.#move(result.caret); }
          return { disposition: 'committed' };
        } finally { this.#engine.history({ type: 'boundary' }); }
      }
      const commands: EditorCommand[] = [];
      const caret = anchor(start.node, start.offset);
      if (action === 'indent' || action === 'outdent') {
        const parent = this.#engine.read().visible.find(n => n.id === node.parent);
        if (parent?.kind === 'list') {
          for (const item of nodes.slice(si, ei + 1)) commands.push({ type: action, owner: item.id });
        } else if (kind(node) === 'code' && si === ei) {
          if (collapsed && action === 'indent') commands.push({ type: 'insert', at: caret, text: '\t' });
          else {
            const text = node.runs.map(run => run.text).join('');
            const first = start.offset === 0 ? 0 : text.lastIndexOf('\n', start.offset - 1) + 1;
            const last = end.offset > start.offset && text[end.offset - 1] === '\n' ? end.offset - 1 : end.offset;
            const lines = [first]; for (let i = first; i < last; i++) if (text[i] === '\n') lines.push(i + 1);
            for (const offset of lines.reverse()) {
              if (action === 'indent') commands.push({ type: 'insert', at: anchor(node.id, offset), text: '\t' });
              else {
                const width = text[offset] === '\t' ? 1 : /^ {1,4}/u.exec(text.slice(offset))?.[0].length ?? 0;
                if (width) commands.push({ type: 'delete', range: { anchor: anchor(node.id, offset), focus: anchor(node.id, offset + width) } });
              }
            }
          }
        } else return undefined;
      } else {
        if ((action === 'backward' || action === 'forward') && collapsed) {
          const adjacent = action === 'backward' && start.offset === 0 ? nodes[si - 1] : action === 'forward' && start.offset === length(node) ? nodes[si + 1] : undefined;
          if (adjacent && adjacent.parent === node.parent && this.#renderer.getBlock(adjacent.id)?.contentEditable === 'false') {
            const element = this.#renderer.getBlock(adjacent.id);
            if (!element) return rejected('unmapped-atom');
            const range = this.#renderer.root.ownerDocument.createRange(); range.selectNode(element);
            const native = this.#renderer.root.ownerDocument.getSelection(); native?.removeAllRanges(); native?.addRange(range);
            this.#selection.clear(); return { disposition: 'handled' };
          }
          if (action === 'backward' && start.offset === 0) {
            const parent = this.#engine.read().visible.find(n => n.id === node.parent);
            if (parent?.kind === 'list' || parent?.kind === 'quote') commands.push({ type: 'backspace', owner: node.id, at: caret });
            else if (si > 0 && nodes[si - 1]!.parent === node.parent) commands.push({ type: 'join', first: nodes[si - 1]!.id, second: node.id });
            else return { disposition: 'handled' };
          } else if (action === 'forward' && start.offset === length(node)) {
            if (nodes[si + 1]?.parent === node.parent) commands.push({ type: 'join', first: node.id, second: nodes[si + 1]!.id });
            else return { disposition: 'handled' };
          } else commands.push({ type: 'deleteGraphemeAt', owner: node.id, offset: start.offset, backward: action === 'backward' });
        } else {
          if (!collapsed) {
            if (si === ei) commands.push({ type: 'delete', range: target.range });
            else {
              for (let i = si; i <= ei; i++) {
                const current = nodes[i]!;
                commands.push({ type: 'delete', range: { anchor: anchor(current.id, i === si ? start.offset : 0), focus: anchor(current.id, i === ei ? end.offset : length(current)) } });
                if (i > si) commands.push({ type: 'join', first: node.id, second: current.id });
              }
            }
          }
          if (action === 'break' || action === 'enter' && kind(node) === 'code') commands.push({ type: 'hardBreak', at: caret });
          else if (action === 'enter') {
            const parent = this.#engine.read().visible.find(n => n.id === node.parent);
            if (parent?.kind === 'list' || parent?.kind === 'quote' && (length(node) > 0 || !nodes.slice(si + 1).some(n => n.parent === node.parent))) commands.push({ type: 'enter', owner: node.id, at: caret });
            else if (kind(node) === 'heading') {
              // Replacement retains the first prefix and last suffix, including
              // cross-block selections. Choose Enter from that staged content.
              const suffix = length(nodes[ei]!) - end.offset;
              if (start.offset + suffix === 0) commands.push({ type: 'setParagraph', owner: node.id });
              else if (suffix === 0) commands.push({ type: 'headingEnd', owner: node.id, at: caret });
              else commands.push({ type: 'split', owner: node.id, at: caret });
            }
            else commands.push({ type: 'split', owner: node.id, at: caret });
          }
        }
      }
      if (!commands.length) return { disposition: 'handled' };
      commands.unshift({ type: 'historySelectionAt', anchor: { owner: a.node, offset: a.offset, bias: a.bias }, focus: { owner: b.node, offset: b.offset, bias: b.bias } });
      const request: PrepareRequest = { kind: 'editor', origin, commands };
      if (!this.#engine.can(request)) return action === 'indent' || action === 'outdent' ? undefined : rejected('inapplicable-command');
      this.#engine.history({ type: 'explicit' });
      const pending = (action === 'enter' || action === 'break') ? this.formatting.typing(target.range) : undefined;
      const result = this.#commit(request);
      if (result.caret) tokens.push(result.caret);
      // Indentation preserves an expanded range/direction; structural edits use
      // a stable cut which resolves through the split/join presentation.
      if (result.caret) this.#move(result.caret);
      else if (action === 'indent' || action === 'outdent') {
        if (collapsed) this.#move(caret); else this.#restore(target);
      } else if (!collapsed && (action === 'break' || action === 'enter' && kind(node) === 'code')) {
        // Replacing selected text may keep the cut anchored before the inserted LF.
        // The authored selection result is after this transaction's hard break.
        const at = this.#engine.resolve(caret);
        if (at.type === 'position') {
          const after = this.#engine.anchor(at.node, start.offset + 1, 'right');
          try { this.#move(after); } finally { this.#engine.releaseAnchor(after); }
        }
      } else this.#move(caret);
      if (pending) { delete pending.link; delete pending.code; this.formatting.remember(pending); }
      return { disposition: 'committed' };
    } catch (error) { return rejected(errorMessage(error)); }
    finally { for (const token of tokens) this.#engine.releaseAnchor(token); target.dispose(); }
  }

  /** Link UI and host toolbar both use the same captured formatting target. */
  openLink(): CommandResult {
    if (this.#disposed || this.#blocked()) return rejected('read-only-or-composing');
    const target = this.captureToolbar();
    if (!target || target.state('link') === 'disabled') { target?.dispose(); return rejected('unsupported-formatting'); }
    this.#closeLink();
    const retained = this.#selection.retain();
    if (!retained) { target.dispose(); return rejected('unmapped-selection'); }
    const doc = this.#renderer.root.ownerDocument, form = doc.createElement('form');
    form.setAttribute('role', 'dialog'); form.setAttribute('aria-label', 'Edit link');
    form.dataset.editacUi = '';
    const label = doc.createElement('label'); label.textContent = 'Link URL';
    const input = doc.createElement('input'); input.type = 'url'; input.value = String(this.formatting.typing(retained.range).link ?? ''); const initial = input.value; label.append(input);
    const apply = doc.createElement('button'); apply.type = 'submit'; apply.textContent = 'Apply link';
    const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel link';
    const status = doc.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true');
    form.append(label, apply, cancel, status); this.#help.after(form); this.#link = { element: form, target, selection: retained };
    cancel.addEventListener('click', () => this.#closeLink(true));
    form.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); this.#closeLink(true); this.#escape = true; } });
    form.addEventListener('submit', event => {
      event.preventDefault(); event.stopPropagation(); // owned dialog must not submit a host form
      if (input.value === initial) { this.#closeLink(true); return; }
      const result = target.apply({ link: input.value || null });
      if (result.disposition === 'rejected') { status.textContent = Array.from(result.reason ?? 'Link unavailable').slice(0, 240).join(''); return; }
      this.#closeLink(); this.#renderer.root.focus();
    });
    input.focus(); return { disposition: 'handled' };
  }
  #closeLink(restore = false): void {
    const link = this.#link; if (!link) return; this.#link = undefined;
    if (restore) { this.#renderer.root.focus(); this.#selection.restoreRetained(link.selection); }
    link.target.dispose(); link.selection.dispose(); link.element.remove();
  }
  captureToolbar(): ToolbarTarget | undefined { this.resetFocusEscape(); return this.formatting.capture(); }
  #move(token: AnchorToken): void { this.#selection.move(token); }
  #restore(target: RetainedSelection): void { this.#selection.restoreRetained(target); }
  dispose(): void {
    for (const target of this.#historyTargets) target.dispose();
    if (this.#disposed) return;
    this.#disposed = true; for (const target of this.#commandTargets) target.dispose(); this.#closeLink(); this.#help.remove();
    const root = this.#renderer.root, current = root.getAttribute('aria-describedby');
    const installed = [this.#description, this.#help.id].filter(Boolean).join(' ');
    const description = current === installed ? this.#description : current?.split(/\s+/u).filter(id => id !== this.#help.id).join(' ');
    if (description !== null && description !== undefined) root.setAttribute('aria-describedby', description); else root.removeAttribute('aria-describedby');
    this.formatting.dispose();
  }
}
