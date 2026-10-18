# Author an extension

Import `Extension` and `createEditor` from `@edit-ac/web`. The runnable original
consumers in `recipes.mjs` use the public v1 descriptor and unchanged production
WASM (`editac.registry.editor.v5` schema). Choose `EmphasisShortcut.configure({ enabled: true })`,
`ReviewMark.configure()`, or `TicketAtom.configure()` in `extensions`. After
`editor.ready`, select text and call
`editor.runExtensionCommand('example.emphasis', 'emphasize')`; `Alpha` becomes
bold in one undoable operation. The mark/atom `insert` command replaces the
current selection with its string argument and a bounded portable data envelope.
Absent presenters and unknown definitions retain the original label text/data.
The same configuration works with `mountEditorSurface`.

`Extension.create` accepts the versioned portable definition, JSON defaults and
an option validator, explicit interests, and trusted host callbacks. `configure`
clones/freezes options without changing identity or data version. Retain the
configured value: cloning it loses its separately held host callbacks and is
rejected before attachment. Invalid/duplicate/incompatible definitions, unknown
options, ambiguous input priorities and codec conflicts also fail before attach.
The examples declare their own capability/qualification metadata; that declaration
is not third-party security review, native support, publication or release proof.

`onAttach(options, context)` returns synchronous cleanup; `onPatch` uses only
explicit operation kinds and optional source-local UTF-16 ranges/selection.
Operation kinds identify the committed command family: direct format batches emit
`Format`; prepared editor commands (including split and toolbar formatting) emit
`Editor`. Subscribe to the actual owner family rather than inferring it from
visible content. The direct Rust `Structure` channel is supported by the runtime
but is not emitted by the browser editor-command facade.
No interests means no input observation. `context.subscribe` uses the existing
indexed ModuleRuntime; explicitly declaring broad interests also declares their
cost. At most 64 interests, additional subscriptions, commands and input rules
are admitted per extension. The profile accepts at most 256 selected descriptors,
within the existing portable JSON budget. Dispatch work is proportional to the
selected operation/source candidates and changed patch ranges, never the registry
or a document snapshot. `moduleRuntime.takeWork()` resets deterministic counters;
it does not establish latency or byte-budget qualification.

Command callbacks return a `PrepareRequest` or `undefined`. The surface prepares,
validates and commits through its existing storage/history owner. It applies the
prepared result selection, releases result anchors and returns the committed revision. `captureTarget`
uses stable anchors; targets captured while preparing a command or input rule
are released after that synchronous operation. Outside that scope, release them
explicitly or attachment cleanup releases them. `captureCommand` delegates to
existing built-in commands and rechecks authority on execution. `can`, `commit`
and commands reject readonly, composition, unready or detached attachment work.
Host callback code is trusted application code, not an isolated plugin sandbox.
It receives no raw CRDT, writable engine or document DOM state port.

Input rules select `type: 'key' | 'input' | 'paste'`, an exact key/inputType/MIME,
an integer priority and a synchronous `prepare` callback. Higher priority runs
first; a returned request consumes input only after a successful commit. Equal
priorities for the same route reject before attachment. Authored rules run after
composition/foreign-control ownership checks and before ordinary input defaults;
paste rules run before clipboard defaults. Metadata includes key modifiers and
at most 4096 UTF-16 units of text. Composing, cancelled, readonly, oversized or
uninterested input never invokes a rule. The callback must prepare one request;
performing additional side effects inside a prepare callback is unsupported.

`context.manage` accepts an abort-aware resource loader, bounds concurrent work
to eight per attachment, reports failure without semantic mutation and disposes
late results after detach. `editor.takeExtensionErrors()` returns bounded
extension/phase diagnostics without callback error text or private payloads. `cleanup` returns an idempotent disposer. Attachment
ownership allows at most 512 outstanding cleanup resources; release short-lived
captures instead of retaining them. Stable-target matching, cache policies and
resolver revalidation are delivered separately by EXT-1.16: a generic resource
loader alone does not authorize applying a stale asynchronous result.

`renderers` adapts existing ModuleRenderer ephemeral views for this extension's
admitted data type. The SDK keeps canonical source text, validates the portable
payload and disposes failed views; host views must allocate exception-safely and
return synchronous update/dispose hooks. `markdown` is a pure MarkdownCodec; `clipboardCodecs` prepare fragments from
bounded source. Both use existing source-preserving codec owners without exposing
an engine handle. Keyboard syntax rules use the local input hooks. Select one Markdown owner;
reserved or duplicate clipboard MIME types reject. Those ports do not turn a
codec into arbitrary new semantics or a second document/history implementation.

A data-defined mark/atom can use admitted schema and prepared transfer primitives
without rebuilding WASM. New editing semantics, arbitrary attributes, new ABI
commands or schema migrations require the shared Rust/Session owner. Browser
callbacks do not execute on native clients. Unknown data must retain fallback;
callbacks, credentials and renderers never enter stored document data. This
recipe makes no provider/network calls. Run `node scripts/test-extension-dx.mjs
--group authoring` from `core` after building with the configured toolchain for
installed public-import, real browser history/fallback and indexed work checks.
