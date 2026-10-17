import { Extension } from '@edit-ac/web';

/** Portable metadata, frozen before attachment; host callbacks stay outside data. */
export function feature(id, definition) {
  return { id, version: 1, schemas: ['editac.registry.editor.v5'], capabilities: ['commands','source-fallback'], permissions: [], requires: [], conflicts: [], bindings: [],
    qualification: 'qualified', owner: 'authoring-example',
    ownership: { focus: 'host', nestedControls: 'exclude', drag: 'host-text-or-block', composition: 'exclude', selection: 'prepared-result', history: 'one-intent', presenters: [], cancellation: 'abort-and-revision', teardown: 'idempotent' },
    ...(definition ? { definition } : {}) };
}
export const EmphasisShortcut = Extension.create({
  apiVersion: 1, feature: feature('example.emphasis'), semantics: { kind: 'behavior' },
  defaults: { enabled: true }, validateOptions: options => typeof options.enabled === 'boolean', loading: 'required-input', interests: [],
  // Options are per instance. Capture the current stable target and use the
  // existing command owner; this example needs no new semantic command.
  onAttach(options, context) { if (options.enabled) { /* lifecycle setup, no input observation */ } },
  commands: { emphasize(_argument, context, options) {
    if (!options.enabled) return;
    const target = context.captureTarget(); if (!target) return;
    return { kind: 'format', origin: 'local:example-emphasis', marks: [{ range: target.range, mark: 'bold', action: 'apply' }], blocks: [] };
  } },
});
function data(type, kind) {
  const definition = { type, version: 1, kind, attributes: { label: { type: 'string', required: true, maxUtf16: 64 } }, content: { type: 'text', maxUtf16: 256 }, fallback: { type: 'text', source: 'content' } };
  return Extension.create({ apiVersion: 1, feature: feature(type, definition), semantics: { kind: 'data', definition }, defaults: {}, validateOptions: () => true,
    loading: 'required-input', interests: [],
    commands: { insert(argument, context) {
      if (typeof argument !== 'string' || argument.length > 64) return;
      const target = context.captureTarget(); if (!target) return;
      return { kind: 'fragment', origin: 'local:example-data', range: target.range,
        blocks: [{ attributes: { type: 'paragraph' }, runs: [{ text: argument, marks: [], attributes: { ['module:' + type]: [1, { label: argument }] } }] }] };
    } },
  });
}
export const ReviewMark = data('example.review', 'mark');
export const TicketAtom = data('example.ticket', 'inline-atom');
