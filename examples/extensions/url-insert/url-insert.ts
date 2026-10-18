import { Extension, type PatternControllerV1, type PatternOptionsV1 } from '@edit-ac/web';
export type UrlInsertHost = Readonly<{
  representation?: 'link' | 'reference';
  permission: PatternOptionsV1['permission']; resolve: PatternOptionsV1['resolve'];
  onStatus?: PatternOptionsV1['onStatus']; literal?: PatternOptionsV1['literal'];
  subscribe?: (invalidate: () => void) => () => void;
  attached?: (controller: PatternControllerV1) => void;
}>;
/** Explicitly select this recipe to resolve authored/pasted absolute HTTPS URLs.
 * The shared matcher owns URL safety, anchors, authority, cancellation and history.
 * The host must authorize and return a found URL; this recipe never fetches.
 */
export function createUrlInsert(host: UrlInsertHost) {
  if (host.representation !== undefined && !['link', 'reference'].includes(host.representation)) throw Error('url-representation');
  const reference = host.representation === 'reference';
  const definition = { type: 'example.url-reference', version: 1, kind: 'inline-atom',
    attributes: { href: { type: 'string', required: true, maxUtf16: 2048 }, label: { type: 'string', required: true, maxUtf16: 248 } },
    content: { type: 'text', maxUtf16: 248 }, fallback: { type: 'text', source: 'content' } } as const;
  return Extension.create<{ paste: boolean; timeoutMs: number }>({
    apiVersion: 1,
    feature: { id: reference ? definition.type : 'example.url-insert', ...(reference ? { definition } : {}), version: 1, schemas: ['editac.registry.editor.v5'], capabilities: ['commands'],
      permissions: [], requires: [], conflicts: [], bindings: [], qualification: 'qualified', owner: 'url-insert-example',
      ownership: { focus: 'host', nestedControls: 'exclude', drag: 'host-text-or-block', composition: 'exclude',
        selection: 'prepared-result', history: 'one-intent', presenters: [], cancellation: 'abort-and-revision', teardown: 'idempotent' } },
    semantics: reference ? { kind: 'data', definition } : { kind: 'behavior' }, defaults: { paste: true, timeoutMs: 5000 },
    validateOptions: o => typeof o.paste === 'boolean' && Number.isSafeInteger(o.timeoutMs) && o.timeoutMs >= 1 && o.timeoutMs <= 30000,
    loading: 'required-input', interests: [],
    onAttach(options, context) {
      const controller = context.match({
        contextUtf16: 512, maxMatches: 4, concurrency: 1, queue: 4, cacheEntries: 4, cacheMs: 5000,
        timeoutMs: options.timeoutMs, paste: options.paste ? 'match' : 'ignore',
        match(window) {
          const result = [];
          // Delimiters are excluded from the link; end-of-input is supported for paste.
          for (const m of window.text.matchAll(/(?:^|[\s(])(https:\/\/[^\s<>"()]{1,240})(?=$|[\s)])/gu)) {
            const text = m[1]!, start = m.index! + m[0].length - text.length;
            if (start === 0 && window.start !== 0) continue;
            result.push({ start, end: start + text.length, text });
            if (result.length === 4) break;
          }
          return result;
        },
        permission: host.permission, resolve: host.resolve, onStatus: host.onStatus, literal: host.literal,
        // A data-defined inline atom is optional. Only the shared matcher’s
        // validated/authorized found result reaches this pure fragment builder.
        prepare: reference ? ({ range, text, href }) => ({ kind: 'fragment', origin: 'local:example-url-reference', range,
          blocks: [{ attributes: { type: 'paragraph' }, runs: [{ text, marks: [],
            attributes: { 'module:example.url-reference': [1, { href, label: text }] } }] }] }) : undefined,
      });
      if (host.subscribe) context.cleanup(host.subscribe(() => controller.invalidate()));
      host.attached?.(controller);
    },
  });
}
/** Prepared allowlist, not a public metadata service or inferred redirect. */
export const preparedUrls = Object.freeze({ 'https://notes.example.test/one': 'https://docs.example.test/notes/one' });
export const preparedUrlResolver: UrlInsertHost['resolve'] = ({ text, signal }) => {
  if (signal.aborted) return { status: 'unavailable' };
  const href = Object.hasOwn(preparedUrls, text) ? preparedUrls[text as keyof typeof preparedUrls] : undefined;
  return href ? { status: 'available', href } : { status: 'missing' };
};
