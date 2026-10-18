import type { CommitResult, EditorCommand, EngineHandle, MarkCommand, PrepareRequest, StableRange } from '@edit-ac/core';
import type { DOMRenderer } from '../dom/render.js';
import type { DOMSelection, RetainedSelection } from '../dom/selection.js';
import { errorMessage, rejected } from '../errors.js';
import type { CommandResult } from '../input/keyboard.js';

type Mark = MarkCommand['mark'];
export type MarkState = 'on' | 'off' | 'mixed' | 'disabled';
/** Only supplied fields change. null removes a field; link values are URLs. */
export type FormattingChanges = Partial<Record<Mark, boolean | string | null>>;
export interface ToolbarTarget {
  readonly active: boolean;
  state(mark: Mark): MarkState;
  applicable(mark: Mark): boolean;
  format(mark: Mark): CommandResult;
  apply(changes: FormattingChanges): CommandResult;
  clear(): CommandResult;
  dispose(): void;
}
const marks: Mark[] = ['bold', 'italic', 'strike', 'underline', 'code', 'link'];
const presentation: Mark[] = ['bold', 'italic', 'strike', 'underline', 'code'];
type Values = Partial<Record<Mark, boolean | string>>;
interface Point { node: string; offset: number }

/** Local typing state, shared by the toolbar, keyboard and ordinary input.
 * Committed formatting still belongs exclusively to the prepared Rust engine.
 */
export class FormattingInput {
  #pending: { point: Point; values: Values } | undefined;
  #disposed = false;
  #sequence = 0;
  readonly #selectionChanged = (): void => {
    if (!this.#pending || this.selection.suspended) return;
    const native = this.renderer.root.ownerDocument.getSelection();
    if (!native?.anchorNode || !native.focusNode) return;
    const a = this.selection.toModel(native.anchorNode, native.anchorOffset), b = this.selection.toModel(native.focusNode, native.focusOffset);
    if (a && b && (a.node !== b.node || a.offset !== b.offset || a.node !== this.#pending.point.node || a.offset !== this.#pending.point.offset)) this.reset();
  };
  readonly #targets = new Set<RetainedSelection>();
  readonly #focusCleanup = new Map<RetainedSelection, () => void>();
  constructor(readonly renderer: DOMRenderer, readonly selection: DOMSelection,
    readonly engine: EngineHandle, readonly commit: (request: PrepareRequest) => CommitResult,
    readonly blocked: () => boolean, readonly allowed: (mark: Mark) => boolean = () => true, readonly ownsFocus: (node: Element) => boolean = () => false) {
    renderer.root.ownerDocument.addEventListener('selectionchange', this.#selectionChanged);
  }

  #points(range: StableRange) {
    const a = this.engine.resolve(range.anchor), b = this.engine.resolve(range.focus);
    if (a.type !== 'position' || b.type !== 'position') return undefined;
    const nodes = this.engine.read().visible.filter(n => n.kind === 'block');
    const ai = nodes.findIndex(n => n.id === a.node), bi = nodes.findIndex(n => n.id === b.node);
    if (ai < 0 || bi < 0) return undefined;
    const [start, end] = ai < bi || ai === bi && a.offset <= b.offset ? [a, b] : [b, a];
    return { a, b, start, end, nodes, collapsed: a.node === b.node && a.offset === b.offset };
  }
  #values(point: Point): Values {
    const node = this.engine.read().visible.find(n => n.id === point.node);
    if (!node || Array.isArray(node.blockAttributes) && node.blockAttributes[0] === 'code') return {};
    let offset = 0;
    for (const [index, run] of node.runs.entries()) {
      const end = offset + run.text.length;
      if (point.offset > offset && point.offset <= end || point.offset === 0 && offset === 0) {
        const values: Values = {};
        for (const mark of marks) {
          const value = run.attributes[mark];
          if (value === true || mark === 'link' && typeof value === 'string' && (point.offset < end || node.runs[index + 1]?.attributes.link === value)) values[mark] = value;
        }
        return values;
      }
      offset = end;
    }
    return {};
  }
  typing(range: StableRange): Values {
    const p = this.#points(range);
    if (!p) return {};
    if (this.#pending && p.collapsed && this.#pending.point.node === p.a.node && this.#pending.point.offset === p.a.offset) return { ...this.#pending.values };
    this.#pending = undefined;
    // Replacement takes the first selected character, while a collapsed caret
    // inherits its left context (with the explicit end-of-link exclusion).
    return this.#values(p.collapsed ? p.start : { ...p.start, offset: p.start.offset + 1 });
  }
  remember(values: Values): void {
    const range = this.selection.current?.range, p = range && this.#points(range);
    this.#pending = p?.collapsed ? { point: { node: p.a.node, offset: p.a.offset }, values: { ...values } } : undefined;
  }
  reset(): void { this.#pending = undefined; }
  /** Replace and set exact supported typing properties in one prepared batch.
   * Unknown attributes remain engine-owned and are never normalized here. */
  replacement(range: StableRange, text: string, origin: string): PrepareRequest {
    const p = this.#points(range);
    if (!p || p.a.node !== p.b.node || !text) return { kind: 'text', origin, command: { type: 'replace', range, text } };
    const node = p.nodes.find(n => n.id === p.start.node)!;
    // Literal code blocks have no inline-formatting applicability. Preserve the
    // existing text route and its history bookmarks rather than adding marks.
    if (Array.isArray(node.blockAttributes) && node.blockAttributes[0] === 'code') return { kind: 'text', origin, command: { type: 'replace', range, text } };
    const values = this.typing(range), from = p.start.offset, to = from + text.length;
    const commands: EditorCommand[] = [
      { type: 'historySelectionAt', anchor: { owner: p.a.node, offset: p.a.offset, bias: p.a.bias }, focus: { owner: p.b.node, offset: p.b.offset, bias: p.b.bias } },
      { type: 'replace', range, text },
    ];
    // Remove incompatible marks before applying code/other intentional values.
    for (const mark of marks) if (!values[mark]) commands.push({ type: 'markAt', owner: p.start.node, from, to, mark, action: 'remove' });
    for (const mark of marks) if (values[mark]) commands.push({ type: 'markAt', owner: p.start.node, from, to, mark, action: 'apply', ...(mark === 'link' ? { href: String(values[mark]) } : {}) });
    const point = { owner: p.start.node, offset: to, bias: 'right' as const };
    commands.push({ type: 'selectionAt', anchor: point, focus: point });
    return { kind: 'editor', origin, commands };
  }
  capture(): ToolbarTarget | undefined {
    if (this.#disposed || this.blocked() || this.renderer.root.ownerDocument.activeElement !== this.renderer.root) return undefined;
    const target = this.selection.retain() ?? this.selection.retainSelectedText(); if (!target) return undefined;
    this.#targets.add(target);
    let redirected = false;
    const root = this.renderer.root, doc = root.ownerDocument;
    const focus = (event: FocusEvent): void => {
      const node = event.target;
      if (node instanceof Element && !root.contains(node) && node.closest('[contenteditable="true"], [role="textbox"]')) redirected = true;
    };
    doc.addEventListener('focusin', focus);
    this.#focusCleanup.set(target, () => doc.removeEventListener('focusin', focus));
    let revision = this.engine.read().revision;
    // Legacy formatting targets survive a canceled host dialog. They cannot
    // activate while another editable control owns focus; captured commands
    // separately dispose/invalidate their single-use intent on cancellation.
    const foreignControl = () => {
      const active = doc.activeElement;
      return active instanceof Element && active !== root && !this.ownsFocus(active) &&
        !!active.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
    };
    const valid = () => !redirected && !foreignControl() && !this.#disposed && !this.blocked() && target.active && this.engine.read().revision === revision && !!this.#points(target.range);
    const state = (mark: Mark): MarkState => {
      if (!valid() || !this.allowed(mark)) return 'disabled';
      const p = this.#points(target.range)!;
      if (!this.engine.can({ kind: 'format', origin: 'format-state', marks: [{ range: target.range, mark, action: 'remove' }], blocks: [] })) return 'disabled';
      if (p.collapsed) {
        const values = this.typing(target.range);
        if (mark !== 'code' && values.code || mark === 'code' && marks.some(m => m !== 'code' && values[m])) return 'disabled';
        return values[mark] ? 'on' : 'off';
      }
      const values: boolean[] = [];
      const si = p.nodes.findIndex(n => n.id === p.start.node), ei = p.nodes.findIndex(n => n.id === p.end.node);
      for (let i = si; i <= ei; i++) {
        const node = p.nodes[i]!; let offset = 0;
        for (const run of node.runs) {
          const end = offset + run.text.length;
          if (end > (i === si ? p.start.offset : 0) && offset < (i === ei ? p.end.offset : Infinity)) values.push(!!run.attributes[mark]);
          offset = end;
        }
      }
      return values.length === 0 ? 'off' : values.every(Boolean) ? 'on' : values.some(Boolean) ? 'mixed' : 'off';
    };
    const apply = (changes: FormattingChanges): CommandResult => {
      if (!valid()) return rejected('stale-or-unavailable-formatting-target');
      const p = this.#points(target.range)!;
      const fields = Object.entries(changes) as [Mark, boolean | string | null][];
      if (fields.some(([mark, value]) => !marks.includes(mark) || mark === 'link' && value !== null && value !== false && typeof value !== 'string' || mark !== 'link' && value !== null && typeof value !== 'boolean')) return rejected('invalid-formatting-field');
      if (fields.some(([mark]) => !this.allowed(mark))) return rejected('command-permission-denied');
      if (p.collapsed) {
        const values = this.typing(target.range);
        for (const [mark, value] of fields) {
          if (!this.engine.can({ kind: 'format', origin: 'format-pending', marks: [{ range: target.range, mark, action: value ? 'apply' : 'remove', ...(mark === 'link' && value ? { href: String(value) } : {}) }], blocks: [] })) return rejected('unsupported-formatting');
          if (value) values[mark] = value; else delete values[mark];
        }
        if (values.code && marks.some(m => m !== 'code' && values[m])) return rejected('incompatible-typing-marks');
        this.#pending = { point: { node: p.a.node, offset: p.a.offset }, values };
        this.renderer.root.focus(); this.selection.restoreRetained(target);
        return { disposition: 'handled' };
      }
      const changed = fields.filter(([mark, value]) => {
        if (state(mark) !== (value ? 'on' : 'off')) return true;
        if (mark !== 'link' || !value) return false;
        const si = p.nodes.findIndex(n => n.id === p.start.node), ei = p.nodes.findIndex(n => n.id === p.end.node);
        for (let i = si; i <= ei; i++) {
          let offset = 0;
          for (const run of p.nodes[i]!.runs) {
            const end = offset + run.text.length;
            if (end > (i === si ? p.start.offset : 0) && offset < (i === ei ? p.end.offset : Infinity) && run.attributes.link !== value) return true;
            offset = end;
          }
        }
        return false;
      });
      if (!changed.length) return { disposition: 'handled' };
      const commands: EditorCommand[] = [{ type: 'historySelectionAt', anchor: { owner: p.a.node, offset: p.a.offset, bias: p.a.bias }, focus: { owner: p.b.node, offset: p.b.offset, bias: p.b.bias } }];
      for (const [mark, value] of changed) {
        const si = p.nodes.findIndex(n => n.id === p.start.node), ei = p.nodes.findIndex(n => n.id === p.end.node);
        for (let i = si; i <= ei; i++) {
          const node = p.nodes[i]!, from = i === si ? p.start.offset : 0, to = i === ei ? p.end.offset : node.runs.reduce((n, r) => n + r.text.length, 0);
          if (from < to) commands.push({ type: 'markAt', owner: node.id, from, to, mark, action: value ? 'apply' : 'remove', ...(mark === 'link' && value ? { href: String(value) } : {}) });
        }
      }
      if (commands.length === 1) return { disposition: 'handled' };
      const request: PrepareRequest = { kind: 'editor', origin: `format:${++this.#sequence}`, commands };
      if (!this.engine.can(request)) return rejected('unsupported-formatting');
      try {
        this.engine.history({ type: 'explicit' }); this.commit(request); revision = this.engine.read().revision;
        this.reset(); this.renderer.root.focus(); this.selection.restoreRetained(target);
        return { disposition: 'committed' };
      } catch (error) { return rejected(errorMessage(error)); }
      finally { this.engine.history({ type: 'boundary' }); }
    };
    return { get active() { return valid(); }, state, applicable: mark => state(mark) !== 'disabled',
      format: mark => mark === 'link' ? rejected('link-requires-url') : apply({ [mark]: state(mark) !== 'on' }), apply,
      clear: () => apply(Object.fromEntries(presentation.map(mark => [mark, null]))),
      dispose: () => { this.#focusCleanup.get(target)?.(); this.#focusCleanup.delete(target); target.dispose(); this.#targets.delete(target); } };
  }
  dispose(): void { this.renderer.root.ownerDocument.removeEventListener('selectionchange', this.#selectionChanged); this.#disposed = true; this.reset(); for (const cleanup of this.#focusCleanup.values()) cleanup(); this.#focusCleanup.clear(); for (const target of this.#targets) target.dispose(); this.#targets.clear(); }
}
