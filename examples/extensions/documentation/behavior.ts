import { Extension, type ExtensionCreateV1 } from '@edit-ac/web';

export function feature(id: string): ExtensionCreateV1<{}>['feature'] {
  return { id, version: 1, schemas: ['editac.registry.editor.v5'], capabilities: ['commands', 'source-fallback'],
    permissions: [], requires: [], conflicts: [], bindings: [], qualification: 'qualified', owner: 'documentation-example',
    ownership: { focus: 'host', nestedControls: 'exclude', drag: 'host-text-or-block', composition: 'exclude',
      selection: 'prepared-result', history: 'one-intent', presenters: [], cancellation: 'abort-and-revision', teardown: 'idempotent' } };
}
export const Emphasis = Extension.create<{ enabled: boolean }>({
  apiVersion: 1, feature: feature('example.documented-emphasis'), semantics: { kind: 'behavior' },
  defaults: { enabled: true }, validateOptions: o => typeof o.enabled === 'boolean',
  loading: 'required-input', interests: [],
  commands: { emphasize(_argument, context, options) {
    if (!options.enabled) return;
    const target = context.captureTarget(); if (!target) return;
    return { kind: 'format', origin: 'local:documented-emphasis',
      marks: [{ range: target.range, mark: 'bold', action: 'apply' }], blocks: [] };
  } },
});
