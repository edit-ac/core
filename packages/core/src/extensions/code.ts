import type { EngineHandle, StableRange, PrepareRequest, CommitResult, EditorCommand } from '../engine.js';

export const CODE_COMMAND_PROFILE = 'editac.code-conveniences.v1';
export const CODE_COMMAND_LIMIT = 102_400;
export type CodeAction = 'moveUp' | 'moveDown' | 'duplicate' | 'indent' | 'outdent' | 'surround' | 'comment';
export const CODE_PAIRS: Readonly<Record<string, string>> = Object.freeze({ '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" });
const comments: Readonly<Record<string, string>> = Object.freeze({ rust: '//', typescript: '//', javascript: '//', python: '#', bash: '#' });
export class CodeCommandError extends Error {}
export function codeContext(engine: EngineHandle, range: StableRange) {
  const snapshot = engine.read(), a = engine.resolve(range.anchor), f = engine.resolve(range.focus);
  if (a.type !== 'position' || f.type !== 'position' || a.node !== f.node) throw new CodeCommandError('Select text in one code block');
  const node = snapshot.visible.find(n => n.id === a.node), attrs = node?.blockAttributes;
  if (!node || !Array.isArray(attrs) || attrs[0] !== 'code' || typeof attrs[1] !== 'string') throw new CodeCommandError('Code context required');
  const text = node.runs.map(r => r.text).join('');
  if (text.length > CODE_COMMAND_LIMIT || new TextEncoder().encode(text).length > CODE_COMMAND_LIMIT) throw new CodeCommandError('Code command limit');
  // Code's existing semantic profile admits literal unmarked text only.
  if (node.runs.some(r => Object.keys(r.attributes).length)) throw new CodeCommandError('Unsupported code attributes');
  return { owner: node.id, text, language: attrs[1], anchor: a.offset, focus: f.offset, revision: snapshot.revision };
}
export type CodeContext = ReturnType<typeof codeContext>;
export interface CodeEdit { text: string; anchor: number; focus: number }
/** Pure logical LF profile. A terminal LF represents an empty last logical line. */
export function codeEdit(c: CodeContext, action: CodeAction, pair = '('): CodeEdit {
  if (!['moveUp','moveDown','duplicate','indent','outdent','surround','comment'].includes(action)) throw new CodeCommandError('Unsupported code action');
  const {text, anchor, focus} = c, low = Math.min(anchor, focus), high = Math.max(anchor, focus);
  const lines = text.split('\n'), starts = [0];
  for (let i = 0; i < lines.length - 1; i++) starts.push(starts[i]! + lines[i]!.length + 1);
  const lineAt = (offset: number) => { let i = 0; while (i + 1 < starts.length && starts[i + 1]! <= offset) i++; return i; };
  const first = lineAt(low), last = lineAt(high > low && text[high - 1] === '\n' ? high - 1 : high);
  let next = [...lines], outAnchor = anchor, outFocus = focus;
  if (action === 'surround') {
    const close = Object.hasOwn(CODE_PAIRS,pair) ? CODE_PAIRS[pair] : undefined; if (!close) throw new CodeCommandError('Unsupported pair');
    return {text: text.slice(0, low) + pair + text.slice(low, high) + close + text.slice(high), anchor: anchor + 1, focus: focus + 1};
  }
  if (action === 'moveUp' || action === 'moveDown' || action === 'duplicate') {
    if (action === 'moveUp' && first === 0 || action === 'moveDown' && last === lines.length - 1) return {text, anchor, focus};
    let delta: number;
    if (action === 'moveUp') { const previous = next[first - 1]!; next.splice(first - 1, last - first + 2, ...lines.slice(first, last + 1), previous); delta = -(previous.length + 1); }
    else if (action === 'moveDown') { const following = next[last + 1]!; next.splice(first, last - first + 2, following, ...lines.slice(first, last + 1)); delta = following.length + 1; }
    else { const chosen = lines.slice(first, last + 1); next.splice(last + 1, 0, ...chosen); delta = chosen.join('\n').length + 1; }
    // A half-open end at the following line start follows the moved lines,
    // but cannot create an offset past an EOF without a terminal LF.
    const result = next.join('\n');
    return {text: result, anchor: Math.min(result.length, anchor + delta), focus: Math.min(result.length, focus + delta)};
  }
  const prefix = Object.hasOwn(comments,c.language) ? comments[c.language] : undefined;
  if (action === 'comment' && !prefix) throw new CodeCommandError('Line comments unavailable for this language');
  const uncomment = action === 'comment' && lines.slice(first, last + 1).every(l => l.slice(l.match(/^[ \t]*/u)![0].length).startsWith(prefix!));
  const changes: {at: number; removed: number; inserted: string}[] = [];
  for (let i = first; i <= last; i++) {
    const line = lines[i]!, whitespace = line.match(/^[ \t]*/u)![0];
    let at = starts[i]!, removed = 0, inserted = '';
    if (action === 'indent') inserted = '  ';
    else if (action === 'outdent') removed = line.startsWith('\t') ? 1 : line.startsWith('  ') ? 2 : line.startsWith(' ') ? 1 : 0;
    else { at += whitespace.length; if (uncomment) removed = prefix!.length + (line.slice(whitespace.length + prefix!.length).startsWith(' ') ? 1 : 0); else inserted = prefix! + ' '; }
    changes.push({at, removed, inserted});
  }
  let result = text;
  const map = (offset: number) => { let delta = 0; for (const e of changes) { if (offset < e.at) break; if (offset <= e.at + e.removed) return e.at + delta + e.inserted.length; delta += e.inserted.length - e.removed; } return offset + delta; };
  outAnchor = map(anchor); outFocus = map(focus);
  for (const e of changes.reverse()) result = result.slice(0, e.at) + e.inserted + result.slice(e.at + e.removed);
  return {text: result, anchor: outAnchor, focus: outFocus};
}
/** Synchronous validation and one existing prepared engine batch; no alternate document. */
export function commitCodeEdit(engine: EngineHandle, c: CodeContext, edit: CodeEdit, origin: string, commit: (request: PrepareRequest) => CommitResult): CommitResult | undefined {
  const snapshot = engine.read(), current = snapshot.visible.find(n => n.id === c.owner);
  if (snapshot.revision !== c.revision || !current || !Array.isArray(current.blockAttributes) || current.blockAttributes[0] !== 'code' || current.blockAttributes[1] !== c.language || current.runs.map(r=>r.text).join('') !== c.text || current.runs.some(r=>Object.keys(r.attributes).length)) throw new CodeCommandError('Stale or unsupported code context');
  if (![c.anchor,c.focus,edit.anchor,edit.focus].every(Number.isSafeInteger) || c.anchor<0 || c.focus<0 || c.anchor>c.text.length || c.focus>c.text.length || edit.anchor<0 || edit.focus<0 || edit.anchor>edit.text.length || edit.focus>edit.text.length) throw new CodeCommandError('Invalid code selection');
  if (edit.text.length > CODE_COMMAND_LIMIT || new TextEncoder().encode(edit.text).length > CODE_COMMAND_LIMIT) throw new CodeCommandError('Code command limit');
  const position = (offset: number) => ({owner:c.owner, offset, bias:'right' as const});
  const commands: EditorCommand[] = [{type:'historySelectionAt', anchor:position(c.anchor), focus:position(c.focus)}];
  if (edit.text !== c.text) {
    // Keep unchanged code outside the edit on its original CRDT text identities.
    let from = 0; while (from < c.text.length && from < edit.text.length && c.text[from] === edit.text[from]) from++;
    if (from && /[\uDC00-\uDFFF]/u.test(c.text[from] ?? '')) from--;
    let oldEnd = c.text.length, newEnd = edit.text.length;
    while (oldEnd > from && newEnd > from && c.text[oldEnd - 1] === edit.text[newEnd - 1]) { oldEnd--; newEnd--; }
    if (oldEnd < c.text.length && /[\uDC00-\uDFFF]/u.test(c.text[oldEnd] ?? '')) {oldEnd++; newEnd++;}
    commands.push({type:'replaceAt', owner:c.owner, from, to:oldEnd, text:edit.text.slice(from,newEnd)});
  } else if (edit.anchor === c.anchor && edit.focus === c.focus) return;
  commands.push({type:'selectionAt', anchor:position(edit.anchor), focus:position(edit.focus)});
  const request: PrepareRequest = {kind:'editor', origin, commands};
  if (!engine.can(request) || engine.read().revision !== c.revision) throw new CodeCommandError('Code command unavailable');
  engine.history({type:'boundary'}); engine.history({type:'explicit'});
  try {return commit(request);} finally {engine.history({type:'boundary'});}
}
export function executeCodeCommand(engine: EngineHandle, range: StableRange, action: CodeAction, commit: (request: PrepareRequest) => CommitResult, pair?: string): CommitResult | undefined {
  const c = codeContext(engine, range); return commitCodeEdit(engine,c,codeEdit(c,action,pair),'code:'+action,commit);
}
