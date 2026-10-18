import { Extension } from '@edit-ac/web';
import { feature } from './behavior.js';

/** Host owns transient status. The document never stores callback state. */
export function lifecycleRecipe(status: (state: string) => void) {
  return Extension.create({ apiVersion: 1, feature: feature('example.documented-lifecycle'),
    semantics: { kind: 'behavior' }, defaults: {}, validateOptions: () => true,
    loading: 'required-input', interests: [],
    onAttach(_options, context) {
      status('attached');
      context.cleanup(() => status('disposed'));
      void context.manage(async signal => {
        // Substitute bounded trusted work; never put credentials in document data.
        await Promise.resolve();
        if (!signal.aborted) status('ready');
        return { dispose: () => status('resource-disposed') };
      });
    },
    input: [{ type: 'key', key: 'F8', priority: 50, prepare(_input, context) {
      const target = context.captureTarget(); if (!target) return;
      return context.replacement(target.range, 'Ready');
    } }],
  });
}
