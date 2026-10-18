import { Extension, type ClipboardCodec } from '@edit-ac/web';

export const NOTE_MIME = 'application/x-example-note';
export const NOTE_LIMITS = Object.freeze({ bytes: 2048, lines: 8, textUtf16: 128 });
/** Deliberately tiny interchange syntax, not Markdown or HTML.
 * note/1 LF (p|h2|b):TEXT (LF (p|h2|b):TEXT)*
 * No escapes, nesting, links, executable code or implicit plain-text parsing.
 */
export const noteCodec: ClipboardCodec = Object.freeze({
  mime: NOTE_MIME,
  prepare(source: string) {
    if (new TextEncoder().encode(source).length > NOTE_LIMITS.bytes) throw Error('note-size');
    const lines = source.split('\n');
    if (lines.shift() !== 'note/1') throw Error('note-version');
    if (!lines.length || lines.length > NOTE_LIMITS.lines) throw Error('note-lines');
    // Validate every line before returning a fragment; no partial success.
    return lines.map(line => {
      const match = /^(p|h2|b):(.+)$/u.exec(line);
      if (!match || match[2]!.length > NOTE_LIMITS.textUtf16 || /[\u0000-\u001f\u007f-\u009f]/u.test(match[2]!)) throw Error('note-line');
      const kind = match[1]!, text = match[2]!;
      return { attributes: kind === 'h2' ? { type: 'heading' as const, level: 2 } : { type: 'paragraph' as const },
        runs: [{ text, marks: kind === 'b' ? [{ mark: 'bold' as const }] : [] }] };
    });
  },
});
export const Notes = Extension.create({
  apiVersion: 1,
  feature: { id: 'example.notes', version: 1, schemas: ['editac.registry.editor.v5'],
    capabilities: ['commands', 'source-fallback'], permissions: [], requires: [], conflicts: [], bindings: [],
    qualification: 'qualified', owner: 'parsing-example',
    ownership: { focus: 'host', nestedControls: 'exclude', drag: 'host-text-or-block', composition: 'exclude',
      selection: 'prepared-result', history: 'one-intent', presenters: [], cancellation: 'abort-and-revision', teardown: 'idempotent' } },
  semantics: { kind: 'behavior' }, defaults: {}, validateOptions: () => true,
  loading: 'required-input', interests: [], clipboardCodecs: [noteCodec],
});
