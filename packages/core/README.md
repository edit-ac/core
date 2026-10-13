# @edit-ac/core

Private development package for the v5 semantic engine. The engine owns one Yrs
replica per handle; the browser adapter renders and edits that replica. Public
types describe implemented commands, anchors, patches, Markdown and checkpoint
operations. Registry release remains pending. Local tarball qualification is recorded by `tests/packed-consumers.test.mjs`.

Use the pinned Rust 1.97.1 toolchain and wasm32-unknown-unknown target. Install
`cargo install wasm-bindgen-cli --version 0.2.129 --locked`, then run
`npm ci` and `npm run build:wasm` from the repository root. `WASM_BINDGEN` may
point to an exact-version CLI binary; the build rejects other versions. Cargo
builds with the lockfile in offline mode, so fetch locked dependencies first
when preparing a new machine. Generated web-target bindings live only in
`dist/wasm/`; they never overwrite this package's metadata or source.

```js
import { init } from '@edit-ac/core';

const runtime = await init('/assets/editac_wasm_bg.wasm');
const engine = runtime.createEngine({
  profile: 'v5',
  documentId: '81000000-0000-4000-8000-000000000100',
  epoch: '82000000-0000-4000-8000-000000000100',
  nodes: [{ text: 'Hello' }],
});
try {
  const node = engine.read().visible[0];
  const at = engine.anchor(node.id, 5, 'right'); // offsets are UTF-16
  try {
    const plan = engine.prepare({
      kind: 'text', origin: 'local:example',
      command: { type: 'insert', at, text: ' world' },
    });
    try { engine.commit(plan); } finally { engine.releasePlan(plan); }
  } finally { engine.releaseAnchor(at); }
  const checkpoint = engine.checkpoint(); // persist envelope and bytes atomically
  console.log(engine.read().visible[0].runs.map(run => run.text).join(''));
} finally {
  engine.dispose();
}
```

The host supplies a nonempty asset URL and serves WASM as `application/wasm`.
The package export `@edit-ac/core/wasm` identifies the packed binary for a host's
asset pipeline; browsers cannot import that binary directly as JavaScript.
The tested loading mode is native browser ESM. Serve `dist/index.js` with its
relative `dist/wasm/editac_wasm.js` dependency, or copy the whole `dist` tree.
The packed-consumer harness also builds React 19.3.0 with esbuild 0.25.12 and
Astro 7.3.8 static/SSR with Node adapter 11.1.7. For a single esbuild output
`/app.js`, copy the packed `dist/wasm/` directory to `/wasm/`: the runtime glue
URL remains relative to the output module. Astro's asset pipeline emits that
glue automatically. In both cases, copy the exported binary into a public asset
location and pass its URL explicitly to `init` and the editor options.

The native ESM fixture loads the core distribution and binary from a separate
HTTP asset origin. That origin must return CORS headers for the consumer.
CSP must permit the module origins in `script-src`, the WASM origin in
`connect-src`, and WebAssembly compilation with `'wasm-unsafe-eval'` in
`script-src`; general `'unsafe-eval'` is unnecessary. Resolve bare SDK imports
through a host import map or a qualified bundler. SSR must not invoke `init`.
These loading checks establish browser mechanics, not CDN deployment or release
performance. Packages remain private and include Apache and third-party notices.

SSR import performs no fetch, browser-global access, instantiation or document
creation. Only `init(assetUrl)` loads the runtime. `createEngine()` creates an
explicit new document with UUID document and epoch identifiers; `restoreEngine(identity, checkpoint, journal)` recovers an
existing document with identity validation. Concurrent calls with the same URL share initialization;
a different URL is rejected after loading starts. A failed load rejects and
allows retry. The production runtime contains no foundation fixture exports.

`prepare()` validates a command before mutation; `can()` checks admissibility.
Plans are scoped to a handle and single use, including failed stale commits.
Anchors survive intervening edits and must be released. `subscribe(scope, callback)`
returns a disposable subscription; observer failures are available through
`takeObserverErrors()` without changing an already committed result.

`EngineError` exposes `code`, `operation` and `message`. Current codes are
`InvalidInput`, `InvalidHandle`, `EngineRejected`, `ResourceLimit` and `Disposed`.
The exported `EngineErrorCode` type also permits future codes; handle unknown
codes explicitly. `can()` returns false for inadmissible requests, while methods
requiring a live handle throw `Disposed` after disposal. Repeated disposal is safe.

`importMarkdown()` prepares supported content and diagnostics without changing the
document. `exportMarkdown()` reports unsupported representations and retains
recovery content. Neither operation implies a live document edit. Apply prepared
blocks through a validated fragment command. Optional codecs are explicit.

`checkpoint()`, `stateVector()`, `encodeUpdate()` and `applyUpdate()` expose the
v5 recovery/synchronization boundary with copied bytes and identity envelopes.
Obtaining bytes or applying a peer update does not establish local durability or
remote settlement. Identity/epoch mismatches reject before mutation. Storage and
transport remain host responsibilities.

The optional qualification entry `@edit-ac/core/fixture` exports `initFixture(assetUrl)`
and `FixtureRuntime`, retaining `createFixture()` and the cumulative fixture-only
`createdDocumentCount()` diagnostic. It requires `npm run build:wasm:fixture`
and the separate `@edit-ac/core/fixture/wasm` asset. These methods moved out of
the private production entry; consumers of the old scaffold probe must explicitly
select this qualification entry. It is not part of the default editor runtime.

`createFixture()` retains the earlier disposable XML/text interoperability probe.
Its `apply_v1(bytes)` accepts trusted fixture updates only; use the production
engine identity boundary for editor updates. The bridge uses Yrs 0.28.0 with
small-client and v1 updates. Neither fixture nor engine import qualifies native
input, OS clipboard or physical-device behavior.

For the actual browser and installed-tarball smoke checks, run
`npx playwright install chromium --only-shell`, then `npm run check:wasm`.
Playwright is pinned in the workspace lockfile. The harness installs a local
tarball offline into a temporary consumer and shuts down its server/browser.

Publishing is disabled until the implementation and release gates in
[edit-ac/architecture](https://github.com/edit-ac/architecture) pass.
License: Apache-2.0.

## Public extension contract v1

Use `@edit-ac/core/extensions` for `ModuleRegistry`, `ModuleContractError`,
`ModuleDefinitionV1`, `ExtensionCommandV1`, `MarkdownCodecV1` and
`MarkdownExtensionV1`. `EXTENSION_API_VERSION` is the literal `1`; a descriptor's
`version` instead identifies that module's stored data, and is a positive u32.
The versioned types alias the existing descriptor, engine commands and trusted
codec hooks. They do not introduce another document model or mutation path.

Register all bounded data-only descriptors before attaching a document and call
`freeze()` (browser mounting freezes automatically). Registration snapshots its
input and validates before insertion. Invalid, duplicate or incompatible entries
throw `ModuleContractError` without replacing existing entries. Known content is
validated with `validate()`/`resolve()`; unknown types/versions keep inert fallback
text and original attributes. Registration neither changes nor migrates a document.

Data-defined marks and inline atoms use the existing attributed-text profile and
can be admitted/read with unchanged engine, WASM and native artifacts. This does
not add an arbitrary-attribute authoring command: use qualified schema admission
and prepared engine primitives. New editing semantics, new content shapes and
schema/epoch migrations require owning core work. Executable renderers and codec
hooks remain trusted host objects, outside descriptor/document data.

Rust consumers use `editac_core::modules::{EXTENSION_API_VERSION, v1}` for
`Definition`, `Registry`, `FrozenRegistry`, `ModuleKind`, `RegistryError`,
`EditorCommand`, `PreparedEditorEdit`, `EditorCommit`, `EditorError`,
`FragmentBlock` and `FragmentRun`. Codec consumers use `editac_markdown::v1`
(`Extension`, `Codecs`, `PreparedContent`, `ImportError`, `ExportResult`,
`import_with_codecs`, `import_with_extensions`, `export`,
`export_with_extensions`). These are re-exports of the owning implementations.
A source-only facade change does not require rebuilding runtime artifacts for
registration. Package publication remains a separate release gate.
