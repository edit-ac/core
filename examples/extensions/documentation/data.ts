import { Extension } from '@edit-ac/web';
import { feature } from './behavior.js';

function data(type: string, kind: 'mark' | 'inline-atom') {
  const definition = { type, version: 1, kind,
    attributes: { label: { type: 'string', required: true, maxUtf16: 64 } },
    content: { type: 'text', maxUtf16: 256 }, fallback: { type: 'text', source: 'content' } } as const;
  return Extension.create({ apiVersion: 1, feature: { ...feature(type), definition },
    semantics: { kind: 'data', definition }, defaults: {}, validateOptions: () => true,
    loading: 'required-input', interests: [],
    commands: { insert(argument, context) {
      if (typeof argument !== 'string' || argument.length > 64) return;
      const target = context.captureTarget(); if (!target) return;
      return { kind: 'fragment', origin: 'local:documented-data', range: target.range,
        blocks: [{ attributes: { type: 'paragraph' }, runs: [{ text: argument, marks: [],
          attributes: { ['module:' + type]: [1, { label: argument }] } }] }] };
    } },
  });
}
export const ReviewMark = data('example.documented-review', 'mark');
export const TicketAtom = data('example.documented-ticket', 'inline-atom');
