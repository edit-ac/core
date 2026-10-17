import { inputTextDiagnostic } from './characters.js';
import type { DOMRenderer } from '../dom/render.js';

export interface NativeRecovery {
  reason: string;
  node?: string;
  text: string;
  truncated: boolean;
}
export type NativeMutation =
  | { type: 'unchanged'; node: string }
  | { type: 'edit'; node: string; before: string; start: number; end: number; text: string; captured: string; caret?: { anchor: number; focus: number } }
  | { type: 'unsupported'; recovery: NativeRecovery; nodes: string[] };

const MAX_RECORDS = 64, MAX_NODES = 2048, MAX_TEXT = 256 * 1024;
function take(nodes: NodeList, limit: number): Node[] {
  const result: Node[] = [];
  for (let i = 0; i < Math.min(nodes.length, limit); i++) result.push(nodes[i]!);
  return result;
}
const inline = new Set(['SPAN', 'STRONG', 'EM', 'U', 'S', 'CODE', 'A', 'BR']);

/** Read only the affected block (or changed nodes for an unmapped mutation).
 * BR contributes a UTF-16 LF; the renderer's empty placeholder contributes zero.
 * This is a text projection, never an HTML import or whole-document diff.
 */
function capture(roots: readonly Node[], validate: boolean): { text: string; truncated: boolean; structure: boolean } {
  const stack = [...roots].reverse(); let text = '', count = 0, structure = false;
  while (stack.length) {
    const node = stack.pop()!;
    if (++count > MAX_NODES) return { text, truncated: true, structure };
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? '', room = MAX_TEXT - text.length;
      text += value.slice(0, room);
      if (value.length > room) return { text, truncated: true, structure };
    } else if (node.nodeType === 1) {
      const element = node as HTMLElement;
      if (validate && (!inline.has(element.tagName) || element.contentEditable === 'false')) structure = true;
      if (element.tagName === 'BR') {
        if (!element.hasAttribute('data-placeholder')) {
          if (text.length === MAX_TEXT) return { text, truncated: true, structure };
          text += '\n';
        }
      } else {
        // Bound the stack as well as traversal; do not allocate an unbounded child list.
        if (element.childNodes.length + stack.length > MAX_NODES) return { text, truncated: true, structure };
        for (let i = element.childNodes.length - 1; i >= 0; i--) stack.push(element.childNodes[i]!);
      }
    } else if (validate) structure = true;
  }
  return { text, truncated: false, structure };
}

/** Bounded semantic text capture shared by native fallback and composition. */
export function captureComposingBlock(renderer: DOMRenderer, node: string): NativeRecovery {
  const block = renderer.getBlock(node);
  if (!block || !renderer.root.contains(block)) return { reason: 'stale-target', node, text: '', truncated: false };
  const value = capture(take(block.childNodes, MAX_NODES), true);
  return { reason: value.truncated || block.childNodes.length > MAX_NODES ? 'native-limit' :
    value.structure ? 'unsupported-composition-structure' : inputTextDiagnostic(value.text) ?? '', node, text: value.text, truncated: value.truncated || block.childNodes.length > MAX_NODES };
}

/** Native offsets are temporary projection state. The edit target itself is
 * anchored by the caller; these offsets are used only after its baseline guard.
 */
function nativeOffset(block: HTMLElement, point: Node | null, offset: number): number | undefined {
  if (!point || !block.contains(point)) return undefined;
  let length = point.nodeType === 3 ? offset : 0;
  if (point.nodeType !== 3) {
    for (const child of take(point.childNodes, offset)) length += capture([child], false).text.length;
  }
  for (let at: Node = point; at !== block; at = at.parentNode!) {
    for (let previous = at.previousSibling; previous; previous = previous.previousSibling) length += capture([previous], false).text.length;
  }
  return length;
}

/** Mutation ownership is established by the caller before comparing text. */
export function reconcileMutation(renderer: DOMRenderer, content: ReadonlyMap<string, string>, records: readonly MutationRecord[]): NativeMutation {
  const bounded = records.slice(0, MAX_RECORDS);
  const owners = new Set(bounded.map(record => renderer.getNodeId(record.target)));
  const nodes = [...owners].filter((id): id is string => id !== undefined);
  const node = owners.size === 1 && !owners.has(undefined) ? nodes[0] : undefined;
  const block = node ? renderer.getBlock(node) : undefined;
  // Never inspect the root's text: unknown structural scope retains changed-node text only.
  const roots = block ? take(block.childNodes, MAX_NODES) : bounded.flatMap(record =>
    record.type === 'characterData' ? [record.target] : take(record.addedNodes.length ? record.addedNodes : record.removedNodes, MAX_RECORDS));
  const value = capture(roots, !!block);
  const reject = (reason: string): NativeMutation => ({ type: 'unsupported', nodes,
    recovery: { reason, ...(node ? { node } : {}), text: value.text, truncated: value.truncated || reason === 'native-limit' } });
  if (records.length > MAX_RECORDS || value.truncated || (block && block.childNodes.length > MAX_NODES)) return reject('native-limit');
  if (!node || !block || !renderer.root.contains(block)) return reject('unsupported-native-scope');
  // New elements may encode formatting/atoms/structure. Leave those semantics to
  // their dedicated commands; a literal pasted text node remains admissible.
  if (block.contentEditable === 'false' || !renderer.positions(node).length || value.structure || bounded.some(record => record.addedNodes.length > MAX_RECORDS || take(record.addedNodes, MAX_RECORDS).some(added => added.nodeType !== 3))) return reject('unsupported-native-structure');
  const diagnostic = inputTextDiagnostic(value.text);
  if (diagnostic) return reject(diagnostic);
  const before = content.get(node);
  if (before === undefined) return reject('stale-target');
  const after = value.text;
  if (before === after) return { type: 'unchanged', node };
  let start = 0, end = before.length, tail = after.length;
  while (start < end && start < tail && before[start] === after[start]) start++;
  while (end > start && tail > start && before[end - 1] === after[tail - 1]) { end--; tail--; }
  // Expand both old/new boundaries together when a shared surrogate is split.
  const low = (char: string | undefined) => !!char && /[\uDC00-\uDFFF]/.test(char);
  if (start > 0 && (low(before[start]) || low(after[start]))) start--;
  if (low(before[end]) || low(after[tail])) { end++; tail++; }
  const selection = block.ownerDocument.getSelection();
  const anchor = nativeOffset(block, selection?.anchorNode ?? null, selection?.anchorOffset ?? 0);
  const focus = nativeOffset(block, selection?.focusNode ?? null, selection?.focusOffset ?? 0);
  return { type: 'edit', node, before, start, end, text: after.slice(start, tail), captured: after,
    ...(anchor !== undefined && focus !== undefined ? { caret: { anchor, focus } } : {}) };
}
