# Executable extension recipes

These original recipes compile from exact manifest ranges against installed packages. Fixtures are hand-authored and use no credentials, live services or public fetch fallback. Use each factory with the same `createEditor(..., { ...recovery, extensions })` configuration path in [getting started](getting-started-v1.md). Each editor retains one engine, history manager and dispatcher. The documentation gate checks independent before/after outcomes, rejection, cancellation and teardown; full earlier recipe qualification remains separately pinned.

## ASD-123 task links

`createTaskLinks(host).configure({ paste: false, timeoutMs: 5000 })` links only found task codes after a delimiter. The host supplies permission and a resolver (the prepared catalog below maps ASD-123 to a fixed HTTPS URL). There is no startup/reopen/remote lookup, template URL interpolation or content upload. While pending, ASD-123 stays literal. Found returns a validated standard link over the same text; missing/denied/unsafe/error never changes text or history. Cancel on disposal, target edit, logout/revision or readonly; unrelated edits may rebase stable anchors. Undo removes linking without immediate reapplication, redo restores it. Paste is explicit. Optional persistent references are a different representation, demonstrated by URL insertion, not a mandatory task-product schema.

<!-- recipe:task-links -->
```ts
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
```
<!-- /recipe:task-links -->

<!-- recipe:catalog -->
```ts
import { type TaskLinkHost } from './task-links.js';

/** Prepared catalog only. Production authorization and credentials stay host-owned. */
export const preparedTaskCatalog: TaskLinkHost = {
  permission: () => ({ principal: 'example-reader', tenant: 'example-team', authority: 'prepared-catalog',
    revision: '1', lookup: true, apply: true }),
  resolve: async request => request.text === 'ASD-123'
    ? { status: 'available', href: 'https://tasks.example.test/ASD-123' }
    : { status: 'missing' },
};
```
<!-- /recipe:catalog -->

## Spelling

Default platform/off modes load no checker. Explicit custom mode requires `overlap: 'allow'`: browser hints cannot promise exclusive suppression. Autocorrection is independent; requested hints do not establish observed OS behavior. `preparedSpelling(container)` returns `{ platform, extensions }`; pass both to the editor. Select custom mode only deliberately. This tiny English fixture recognizes teh/recieve/café/wrng; it is not a production dictionary. Current acceptance changes teh to the in one shared undo action, preserving surrounding formatting/selection. Unknown locale/word, composition/code exclusion, checker failure and stale suggestions never modify text. Buttons/underlines are transient, outside document semantics; disposal removes them and cancels pending work. [The browser runbook](../../examples/extensions/spellcheck/README.md#actual-browser-handoff-to-int-114) is separate from actual OS/native evidence, which stays open.

<!-- recipe:spellcheck -->
```ts
import { Spelling, type SpellingSuggestionV1, type SpellingCheckerV1 } from '@edit-ac/web';
/** Tiny, deliberately incomplete hand-authored fixture. No network/service account. */
export const preparedDictionary: Readonly<Record<string, readonly string[]>> = Object.freeze({ teh: Object.freeze(['the']), recieve: Object.freeze(['receive']), café: Object.freeze(['café']), wrng: Object.freeze(['right']) });
export const preparedChecker: SpellingCheckerV1 = Object.freeze({ locales: Object.freeze(['en']),
  check: (word: string) => Object.hasOwn(preparedDictionary, word) ? preparedDictionary[word]! : [] });
/** Accessible ephemeral suggestions live outside the editor's canonical DOM. */
export function presentSpelling(container: HTMLElement, suggestion: SpellingSuggestionV1) {
  const region = container.ownerDocument.createElement('div'); region.setAttribute('role', 'group');
  region.setAttribute('aria-label', `Spelling suggestions for ${suggestion.word}`);
  const label = container.ownerDocument.createElement('span'); label.textContent = suggestion.word; region.append(label);
  for (const replacement of suggestion.replacements) {
    const button = container.ownerDocument.createElement('button'); button.type = 'button';
    button.textContent = replacement; button.setAttribute('aria-label', `Replace ${suggestion.word} with ${replacement}`);
    button.addEventListener('click', () => suggestion.accept(replacement)); region.append(button);
  }
  const dismiss = container.ownerDocument.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => suggestion.dismiss()); region.append(dismiss); container.append(region);
  let disposed = false;
  return { dispose() { if (disposed) return; disposed = true; region.remove(); } };
}
export function preparedSpelling(container: HTMLElement) {
  return Spelling.configure({ mode: 'custom', locale: 'en', overlap: 'allow',
    checker: { async load() { return preparedChecker; }, present: suggestion => presentSpelling(container, suggestion) } });
}
```
<!-- /recipe:spellcheck -->

## Small source parser

Configure `Notes.configure()`. Supply custom MIME `application/x-example-note`; the grammar is `note/1` plus p:/h2:/b: lines, bounded to 2048 bytes, eight lines and 128 UTF-16 units per field. `note/1\nb:Strong` becomes one bold paragraph. Every line validates before mutation. Unknown version, oversized/unsupported input retains raw recovery and falls through to an available supported flavor, without partial commit. Internal fragments and sanitized HTML precede custom MIME; literal paste bypasses it. Undo/redo is one atomic transfer. Choose a codec for interchange, an input rule for local recognition, or explicit custom-reference data for persistent identity; this is not a general converter.

<!-- recipe:parsing -->
```ts
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
```
<!-- /recipe:parsing -->

## URL insertion

Configure `createUrlInsert(host).configure()` with explicit permission/resolve callbacks. No automatic HTTP request occurs. Safe authorized found results link the original URL; denied/missing/unsafe output leaves input/history unchanged. Generation, stable target, current source and authority are revalidated after awaits; dispose cancels even a resolver that completes late. `representation: 'reference'` selects an admitted inline atom storing exact source label and validated href. With no presenter the source text and opaque versioned data survive; this is not a speculative preview. Credentials remain host-owned. Undo/redo uses the same prepared command and history owner.

<!-- recipe:url-insert -->
```ts
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
```
<!-- /recipe:url-insert -->

See [advanced hosting](hosting-v1.md) for separate worker/assets concerns and [packaging](packaging-v1.md) for reusable third-party checks.
