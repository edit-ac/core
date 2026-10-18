# Author an extension with public version 1 ports

Use `Extension.create` to freeze metadata, typed JSON options, interests and host callbacks. `.configure()` derives isolated immutable options without changing identity or stored-data version. Host callbacks are trusted bounded code, not a sandbox. The engine owns document semantics, validation, authority, stable anchors, transactions and shared undo.

## Behavior and commands

Select `Emphasis.configure()` in `extensions`. Select a text range, then call `editor.runExtensionCommand('example.documented-emphasis', 'emphasize')`. Alpha becomes bold without changing its bytes. Disabled or absent targets do nothing. Readonly execution rejects without changing data. Undo removes that one format intent; disposal makes further command use unavailable. Invalid options reject before root attachment with `ExtensionConfigurationError` fields `code`, `extension`, `option` and `remedy`.

<!-- recipe:behavior -->
```ts
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
```
<!-- /recipe:behavior -->

## Admitted marks and atoms

Select `ReviewMark.configure()` or `TicketAtom.configure()` and run its `insert` command with a string up to 64 UTF-16 units. The selected range becomes that string with versioned module data and a label. Oversized/non-string arguments make no edit. These data definitions use already admitted mark/inline-atom primitives and unchanged production WASM. Without a presenter their source remains visible and survives transfer/reopen. `inline-atom` does not invent a new cursor or deletion model; rendering is optional. A new structural/editing semantic requires its Rust owner, versioned ABI/schema/migration and qualification; arbitrary hot schema registration is unsupported.

<!-- recipe:data -->
```ts
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
```
<!-- /recipe:data -->

## Lifecycle, input and cleanup

The following typed recipe reports attachment/readiness and replaces the current selection with Ready on F8 through one prepared history action. Its host status is ephemeral. It cleans up both attachment and managed resource; failure and late completion release resources. Invoke cleanup once; never use a disposed context.

<!-- recipe:lifecycle -->
```ts
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
```
<!-- /recipe:lifecycle -->

## Public API reference

| Surface | Exact role and boundary |
| --- | --- |
| `ExtensionCreateV1<T>` | `apiVersion: 1`, `feature`, `semantics`, `defaults`, `validateOptions`, `loading`, `interests`; optional hooks below. Use exported types, not a private interface copy. |
| `onAttach(options, context)` | Runs per attachment; may return cleanup. `context.signal` aborts with the owner. `context.cleanup(fn)` registers idempotent teardown. |
| `context.manage(load)` | Loads an attachment-local resource; late results are disposed after abort. Returns whether activation survived. |
| `interests` / `onPatch` | Declare operation/source/range interests once. Existing indexed ModuleRuntime dispatch filters patches; do not rescan the document or registry per keystroke. `context.subscribe(scope, callback)` uses the same owner and teardown. |
| `commands[name]` | Receives JSON argument, context and readonly options; returns one `PrepareRequest` or undefined. The surface prepares/commits under current authority. |
| `context.captureTarget()` | Captures current stable range; context owns release after callback/attachment. Do not retain raw offsets across awaits. |
| `context.replacement(range, text)` | Prepares formatting-aware replacement. Existing engine owns history and result selection. |
| `context.command(name, argument)` | Invokes this extension's existing prepared command route. Readonly/failure cannot be bypassed. |
| `input` | `type: key/input/paste`, `key`, descending numeric `priority`, pure `prepare`. Equal priorities for one key reject. Return undefined to decline. Local/composition/literal ownership stays with input middleware; clipboard precedence stays internal fragment, sanitized HTML, custom MIME, plain text. |
| `clipboardCodecs` / `markdown` | Optional existing `ClipboardCodec`/`MarkdownCodec` adapters, not a second document parser. Notes below validate the whole source before returning admitted fragments. One selected Markdown adapter. |
| `renderers` | Existing `ModuleRenderer` mount/update/dispose hooks provide ephemeral accessible presentation; never mutate canonical editor DOM or store decorations as semantic marks. Missing/failed presenter preserves source fallback. |
| `context.match(options)` | Bounded recognition, principal-scoped cache, permission/resolve, transient status and cancellation; [matching reference](matching.md) defines limits and invalidation. |
| `takeExtensionErrors()` | Surface/BrowserEditor host-safe extension/phase diagnostics; never log secrets or full private resolver results. |

Spelling's `presentSpelling` in [recipes](recipes-v1.md#spelling) demonstrates an accessible suggestion region and buttons outside canonical editor DOM, with exact dispose behavior. The engine replaces text only on accepting a current suggestion; the presenter does not mutate document content. Platform/browser callbacks imply no native execution or OS spelling quality. See [packaging/conformance](packaging-v1.md).
