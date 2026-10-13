/** Presentation only: exact patch admission/application belongs to the session service. */
export type ReviewLayout = 'unified' | 'inline' | 'side-by-side';
export type ReviewMode = 'writable' | 'readonly' | 'history';
export interface ReviewLimits { maxInputBytes: number; pageSize: number; maxValueChars: number }
export const DEFAULT_REVIEW_LIMITS: Readonly<ReviewLimits> = Object.freeze({ maxInputBytes: 2 * 1024 * 1024, pageSize: 100, maxValueChars: 4096 });
export type ReviewInput =
  | { representation: 'exact-source'; wire: string }
  | { representation: 'projected-markdown'; wire: string; serializer: string; dialect: string }
  | { representation: 'semantic'; model: unknown };
export interface ReviewLine { kind: 'Context' | 'Delete' | 'Insert'; text: string }
export interface ReviewHunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: ReviewLine[] }
export interface ReviewChange { id: string; facets: string[]; before: unknown; after: unknown }
export interface ReviewModel {
  representation: ReviewInput['representation']; label: string; explanation: string;
  beforeHash: string; afterHash: string; key: string; hunks: ReviewHunk[]; changes: ReviewChange[];
  retainedStructure: unknown; attribution: string;
}
const hash = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error('Invalid review hash');
  return value;
};
export function reviewLimits(limits: Partial<ReviewLimits> = {}): ReviewLimits {
  const result = { ...DEFAULT_REVIEW_LIMITS, ...limits };
  for (const [key, maximum] of [['maxInputBytes', 16 * 1024 * 1024], ['pageSize', 200], ['maxValueChars', 16384]] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > maximum) throw Error('Invalid review limit');
  }
  return result;
}
const facets = ['Insert','Delete','Visibility','Placement','Kind','Text','Formatting','References','Table','Attributes','UnknownModule','Sources'];
export function prepareReview(input: ReviewInput, suppliedLimits: Partial<ReviewLimits> = {}): ReviewModel {
  const limits = reviewLimits(suppliedLimits);
  // This JSON boundary also freezes host input. It never reads a live document.
  const encoded = JSON.stringify(input);
  if (new TextEncoder().encode(encoded).length > limits.maxInputBytes) throw Error('Review input exceeds byte limit');
  const frozen = JSON.parse(encoded) as ReviewInput;
  if (frozen.representation === 'semantic') {
    const m = frozen.model as Record<string, unknown>;
    if (!m || m.version !== 'editac-semantic-diff-v1' || m.attribution !== 'unknown' || !Array.isArray(m.changes)) throw Error('Unsupported semantic review');
    if (m.retained_structure !== null && (!Array.isArray(m.retained_structure) || m.retained_structure.length !== 2)) throw Error('Invalid retained structure');
    const ids = new Set<string>();
    const changes = m.changes.map((c: ReviewChange) => {
      if (!c || typeof c.id !== 'string' || !c.id || ids.has(c.id) || !Array.isArray(c.facets) || !c.facets.length || c.facets.some(f => !facets.includes(f))) throw Error('Invalid semantic change');
      for (const node of [c.before, c.after]) if (node !== null && (!node || typeof node !== 'object' || Array.isArray(node) || (node as Record<string, unknown>).id !== c.id)) throw Error('Invalid semantic node');
      ids.add(c.id); return c;
    });
    const beforeHash = hash(m.before_hash), afterHash = hash(m.after_hash);
    return { representation: 'semantic', label: 'Semantic changes', explanation: 'Stable identities, content, formatting, references and opaque data. No character author is inferred.', beforeHash, afterHash, key: `semantic:${beforeHash}:${afterHash}`, hunks: [], changes, retainedStructure: m.retained_structure, attribution: 'Unknown / unverified' };
  }
  if (!['exact-source','projected-markdown'].includes(frozen.representation) || typeof frozen.wire !== 'string') throw Error('Unsupported review representation');
  if (frozen.representation === 'projected-markdown' && (!frozen.serializer || !frozen.dialect || typeof frozen.serializer !== 'string' || typeof frozen.dialect !== 'string')) throw Error('Projected Markdown requires serializer and dialect');
  const wire = frozen.wire;
  const prefix = '# editac-exact-patch-v1 ';
  const headerEnd = wire.indexOf('\n');
  if (!wire.startsWith(prefix) || headerEnd < 0 || headerEnd > 2070 || !wire.endsWith('\n')) throw Error('Malformed review patch');
  let metadata;
  try { metadata = JSON.parse(wire.slice(prefix.length, headerEnd)); } catch { throw Error('Malformed review metadata'); }
  if (metadata.representation !== 'exact-source-utf8-v1') throw Error('Unsupported patch representation');
  const beforeHash = hash(metadata.before_hash), afterHash = hash(metadata.after_hash);
  const raw = wire.slice(headerEnd + 1).split('\n');
  if (raw.shift() !== '--- before' || raw.shift() !== '+++ after') throw Error('Malformed patch labels');
  raw.pop();
  const hunks: ReviewHunk[] = [];
  let hunk: ReviewHunk | undefined;
  for (const line of raw) {
    const range = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line);
    if (range) {
      const n = range.slice(1).map(Number);
      if (n.some(v => !Number.isSafeInteger(v))) throw Error('Invalid patch range');
      hunk = { oldStart: n[0]!, oldCount: n[1]!, newStart: n[2]!, newCount: n[3]!, lines: [] };
      hunks.push(hunk);
    } else if (line === '\\ No newline at end of file') {
      const previous = hunk?.lines.at(-1);
      if (!previous || !previous.text.endsWith('\n')) throw Error('Invalid newline marker');
      previous.text = previous.text.slice(0, -1);
    } else {
      if (!hunk || ![' ', '-', '+'].includes(line[0] ?? '')) throw Error('Malformed patch line');
      hunk.lines.push({ kind: line[0] === '-' ? 'Delete' : line[0] === '+' ? 'Insert' : 'Context', text: line.slice(1) + '\n' });
    }
  }
  let oldEnd = 0, newEnd = 0;
  for (const h of hunks) {
    const oldIndex = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    const newIndex = h.newCount === 0 ? h.newStart : h.newStart - 1;
    if (oldIndex < oldEnd || newIndex < newEnd || h.lines.filter(l => l.kind !== 'Insert').length !== h.oldCount || h.lines.filter(l => l.kind !== 'Delete').length !== h.newCount) throw Error('Invalid patch ranges');
    oldEnd = oldIndex + h.oldCount; newEnd = newIndex + h.newCount;
  }
  const projected = frozen.representation === 'projected-markdown';
  return { representation: frozen.representation, label: projected ? 'Projected Markdown changes' : 'Exact source changes', explanation: projected ? `Serialized Markdown (${frozen.serializer}; ${frozen.dialect}). Serialization may normalize source spelling; this is not original source.` : 'Original UTF-8 source spelling, CRLF and final newline. CRDT updates are not source diffs.', beforeHash, afterHash, key: `${frozen.representation}:${projected ? frozen.serializer + ':' + frozen.dialect : ''}:${beforeHash}:${afterHash}`, hunks, changes: [], retainedStructure: null, attribution: 'Unknown / unverified' };
}
