import { errorMessage, rejected } from '../errors.js';
import type { AnchorToken, CommitResult, EditorCommand, EngineHandle, MarkCommand, PrepareRequest, ProjectedNode, StableRange } from '@edit-ac/core';
import type { DOMRenderer } from '../dom/render.js';
import type { DOMSelection, RetainedSelection } from '../dom/selection.js';

export type KeyboardAction = 'enter' | 'break' | 'backward' | 'forward' | 'indent' | 'outdent' | 'undo' | 'redo' | 'bold' | 'italic' | 'underline' | 'strike';
export interface CommandResult { disposition: 'committed' | 'handled' | 'rejected'; reason?: string }
export interface ToolbarTarget { readonly active: boolean; applicable(mark: MarkCommand['mark']): boolean; format(mark: MarkCommand['mark']): CommandResult; dispose(): void }
const kind = (node: ProjectedNode) => Array.isArray(node.blockAttributes) ? node.blockAttributes[0] : undefined;
const length = (node: ProjectedNode) => node.runs.reduce((n, run) => n + run.text.length, 0);

/** Called only after the sole input owner has resolved composition precedence.
 * All content changes are applicability-checked prepared engine transactions.
 * Native visual navigation and ordinary grapheme deletion stay browser-owned.
 */
export class KeyboardInput {
  #disposed = false;
  #escape = false;
  #sequence = 0;
  readonly #targets = new Set<RetainedSelection>();
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
    this.#blocked = blocked;}

  action(event: Event): KeyboardAction | undefined {
    if (event.defaultPrevented) {
      if (event.type === 'keydown' || event.type === 'beforeinput') this.resetFocusEscape();
      return undefined;
    }
    if (event.type === 'beforeinput') {
      this.resetFocusEscape();
      return ({ insertParagraph: 'enter', insertLineBreak: 'break', historyUndo: 'undo', historyRedo: 'redo' } as const)[(event as InputEvent).inputType as 'insertParagraph'];
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
    if (primary && !key.shiftKey) {
      const mark = ({ b: 'bold', i: 'italic', u: 'underline' } as const)[key.key.toLowerCase() as 'b' | 'i' | 'u'];
      if (mark) return mark;
    }
    if (primary && key.shiftKey && key.key.toLowerCase() === 'x') return 'strike';
    if (primary && key.key.toLowerCase() === 'z') return key.shiftKey ? 'redo' : 'undo';
    if (!mac && primary && !key.shiftKey && key.key.toLowerCase() === 'y') return 'redo';
    if (key.ctrlKey || key.metaKey) return undefined;
    if (key.key === 'Escape') { this.#escape = true; return undefined; }
    if (key.key === 'Tab' && escape) return undefined;
    if (key.key === 'Enter') return key.shiftKey ? 'break' : 'enter';
    if (key.key === 'Tab') return key.shiftKey ? 'outdent' : 'indent';
    if (key.key === 'Backspace') return 'backward';
    if (key.key === 'Delete') return 'forward';
    return undefined;
  }

  resetFocusEscape(): void { this.#escape = false; }

  /** Undefined means native ownership: do not prevent the event. */
  execute(action: KeyboardAction, origin = `keyboard:${++this.#sequence}`): CommandResult | undefined {
    this.resetFocusEscape();
    if (this.#disposed || this.#blocked()) return rejected(this.#disposed ? 'disposed' : 'read-only-or-composing');
    const selectedNode = (action === 'backward' || action === 'forward') && this.#selection.selectedNode();
    if (selectedNode) {
      const request: PrepareRequest = { kind: 'editor', origin, commands: [{ type: 'deleteSeparator', owner: selectedNode }] };
      if (!this.#engine.can(request)) return rejected('inapplicable-command');
      this.#engine.history({ type: 'explicit' });
      let caret: AnchorToken | undefined;
      try {
        caret = this.#commit(request).caret;
        if (caret) this.#move(caret);
        return { disposition: 'committed' };
      } catch(error) { return rejected(errorMessage(error)); }
      finally { if (caret) this.#engine.releaseAnchor(caret); this.#engine.history({ type: 'boundary' }); }
    }
    if (action === 'bold' || action === 'italic' || action === 'underline' || action === 'strike') {
      const target = this.captureToolbar(); if (!target) return rejected('unmapped-selection');
      try { return target.format(action); } finally { target.dispose(); this.#engine.history({ type: 'boundary' }); }
    }
    if (action === 'undo' || action === 'redo') {
      this.#engine.history({ type: 'boundary' });
      const before = this.#engine.read().revision;
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
      return { disposition: before === this.#engine.read().revision ? 'handled' : 'committed' };
    }
    if (action === 'enter') {
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
              else if (text[offset] === '\t') commands.push({ type: 'delete', range: { anchor: anchor(node.id, offset), focus: anchor(node.id, offset + 1) } });
            }
          }
        } else return undefined;
      } else {
        if ((action === 'backward' || action === 'forward') && collapsed) {
          if (action === 'backward' && start.offset === 0) {
            const parent = this.#engine.read().visible.find(n => n.id === node.parent);
            if (parent?.kind === 'list' || parent?.kind === 'quote') commands.push({ type: 'backspace', owner: node.id, at: caret });
            else if (si > 0 && nodes[si - 1]!.parent === node.parent) commands.push({ type: 'join', first: nodes[si - 1]!.id, second: node.id });
            else return { disposition: 'handled' };
          } else if (action === 'forward' && start.offset === length(node)) {
            if (nodes[si + 1]?.parent === node.parent) commands.push({ type: 'join', first: node.id, second: nodes[si + 1]!.id });
            else return { disposition: 'handled' };
          } else return undefined;
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
      return { disposition: 'committed' };
    } catch (error) { return rejected(errorMessage(error)); }
    finally { for (const token of tokens) this.#engine.releaseAnchor(token); target.dispose(); }
  }

  captureToolbar(): ToolbarTarget | undefined {
    if (this.#disposed || this.#blocked()) return undefined;
    const target = this.#selection.retain(); if (!target) return undefined;
    this.#targets.add(target);
    const request = (mark: MarkCommand['mark']): PrepareRequest => ({ kind: 'format', origin: `toolbar:${++this.#sequence}`, marks: [{ range: target.range, mark, action: 'toggle' }], blocks: [] });
    const applicable = (mark: MarkCommand['mark']) => !this.#disposed && !this.#blocked() && target.active && this.#engine.can(request(mark));
    return { get active() { return target.active; }, applicable,
      format: mark => {
        this.resetFocusEscape();
        if (!applicable(mark)) return rejected('inapplicable-toolbar-target');
        try { this.#engine.history({ type: 'explicit' }); this.#commit(request(mark)); this.#renderer.root.focus(); this.#restore(target); return { disposition: 'committed' }; }
        catch (error) { return rejected(errorMessage(error)); }
      }, dispose: () => { target.dispose(); this.#targets.delete(target); } };
  }
  #move(token: AnchorToken): void { this.#selection.move(token); }
  #restore(target: RetainedSelection): void { this.#selection.restoreRetained(target); }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; for (const target of this.#targets) target.dispose(); this.#targets.clear(); }
}
