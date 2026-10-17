import { Extension, type PatternControllerV1, type PatternOptionsV1 } from '@edit-ac/web';

export type TaskLinkHost = Readonly<{
  permission: PatternOptionsV1['permission'];
  resolve: PatternOptionsV1['resolve'];
  onStatus?: PatternOptionsV1['onStatus'];
  /** Subscribe to logout, policy or catalog changes. Return the unsubscribe. */
  subscribe?: (invalidate: () => void) => () => void;
  attached?: (controller: PatternControllerV1) => void;
  literal?: PatternOptionsV1['literal'];
}>;

/** Host callbacks/credentials stay outside serializable extension options. */
export function createTaskLinks(host: TaskLinkHost) {
  return Extension.create<{ paste: boolean; timeoutMs: number }>({
    apiVersion: 1,
    feature: {
      id: 'example.task-links', version: 1, schemas: ['editac.registry.editor.v5'],
      capabilities: ['commands'], permissions: [], requires: [], conflicts: [], bindings: [],
      qualification: 'qualified', owner: 'task-links-example',
      ownership: { focus: 'host', nestedControls: 'exclude', drag: 'host-text-or-block',
        composition: 'exclude', selection: 'prepared-result', history: 'one-intent',
        presenters: [], cancellation: 'abort-and-revision', teardown: 'idempotent' },
    },
    semantics: { kind: 'behavior' },
    defaults: { paste: false, timeoutMs: 5000 },
    validateOptions: options => typeof options.paste === 'boolean' &&
      Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1 && options.timeoutMs <= 30000,
    loading: 'required-input', interests: [],
    onAttach(options, context) {
      const controller = context.match({
        contextUtf16: 128, maxMatches: 8, concurrency: 2, queue: 8,
        cacheEntries: 8, cacheMs: 5000, timeoutMs: options.timeoutMs,
        paste: options.paste ? 'match' : 'ignore',
        match(window) {
          const matches = [];
          // ASCII project keys; Unicode word/hyphen prefixes are excluded.
          // A delimiter must actually exist: end-of-input alone is not a trigger.
          const pattern = /(?:^|[^\p{L}\p{N}_-])([A-Z]{2,8}-[0-9]{1,6})(?=[\t\n .,;!?)\]])/gu;
          for (const found of window.text.matchAll(pattern)) {
            const text = found[1]!, start = found.index! + found[0].length - text.length;
            // The bounded window may begin inside an unknown preceding word.
            if (start === 0 && window.start !== 0) continue;
            matches.push({ start, end: start + text.length, text });
            if (matches.length === 8) break;
          }
          return matches;
        },
        permission: host.permission, resolve: host.resolve,
        onStatus: host.onStatus, literal: host.literal,
        // Omit prepare: the shared owner applies one standard link mark,
        // preserving source, adjacent formatting, selection and shared history.
      });
      if (host.subscribe) context.cleanup(host.subscribe(() => controller.invalidate()));
      host.attached?.(controller);
    },
  });
}

/** Hand-authored fixture data, never URL interpolation or a production service. */
export const preparedTasks: Readonly<Record<string, Readonly<{ title: string; href: string }>>> = Object.freeze({
  'ASD-123': Object.freeze({ title: 'Keep the authored task code', href: 'https://tasks.example.test/issues/design-123' }),
  'DOC-7': Object.freeze({ title: 'Write the public recipe', href: 'https://tasks.example.test/issues/documentation-7' }),
});

export const preparedTaskResolver: TaskLinkHost['resolve'] = async ({ text, signal }) => {
  if (signal.aborted) return { status: 'unavailable' };
  const task = Object.hasOwn(preparedTasks, text) ? preparedTasks[text] : undefined;
  return task ? { status: 'available', href: task.href } : { status: 'missing' };
};
