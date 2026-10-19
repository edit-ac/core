/** Ephemeral presentation only. Never stores document revisions, proposals or receipts. */
export const LIMITS = Object.freeze({ entries: 64, text: 4096 });
const kinds = new Set(['notice', 'prose', 'request', 'result']);
export function createTranscript() {
  let entries = [], dropped = 0, sequence = 0;
  return Object.freeze({
    append(kind, text) {
      if (!kinds.has(kind) || typeof text !== 'string') throw new TypeError('Expected a transcript kind and text');
      const entry = Object.freeze({ id: ++sequence, kind, text: text.slice(0, LIMITS.text), truncated: text.length > LIMITS.text });
      entries.push(entry);
      if (entries.length > LIMITS.entries) { entries.shift(); dropped++; }
      return entry.id;
    },
    snapshot() { return Object.freeze({ entries: Object.freeze([...entries]), dropped }); },
    clear() { entries = []; dropped = 0; },
  });
}
