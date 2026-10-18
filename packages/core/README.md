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

### Ordered atomic text and mark batches

Use `prepare({ kind: "editor", origin, commands })` with `replaceAt` and `markAt` for synchronous offsets in the staged document after preceding commands. A final `selectionAt` returns `commit(plan).selection` as two stable anchor tokens; release both when finished. Invalid later commands and invalid selection endpoints reject the entire preparation without live changes. Commit rejects stale plans. Keep asynchronous targets as stable anchors; do not reuse integer offsets after awaiting unrelated work. Existing anchored commands and caret results retain their behavior.

## Portable link ports and presenters

Import supported link records and helpers from `@edit-ac/core/links`. This optional entry exports `LinkRequest`, `LinkResult`/`LinkOutcome`, `LinkHostPorts`, `LinkHostContext`, `LinkAction`, `ValidatedLinkAction`, cache policies, `LinkPresenterSession` and `LinkActivation`. Importing it performs no fetch, WASM initialization, timer or DOM work. The semantic engine never resolves URLs inside transactions. The same portable exports are available at the core package root for existing unbundled import maps. New unbundled browser hosts using the subpaths must map `@edit-ac/core/links` and `@edit-ac/web/links` to their packed `dist/links/index.js` and `dist/modules/links/index.js` files. Browser helpers are documented at `@edit-ac/web/links`.

`LinkPresenterSession` captures a request by value and projects each result against the current owning request, policy, principal, tenant, authority, permission and time. Supply the current request at every read; subscribe to host logout, switch, revoke, lock and expiry events to remove old display. Cancel with an `AbortSignal` or `dispose()`. Every non-available state has a safe user-authored label/status fallback; available private title/icon/preview remain transient per-viewer fields. Never serialize a presentation into shared snapshots. Host asset handles must resolve only to bounded vetted local assets. The presenter retains no resolved metadata; the host owns scoped cache expiry and finite offline leases.

`LinkActivation` rechecks the owning target and current capability through the configured catalog, then dispatches a typed `open-external`, `open-private` or `copy-locator` object. Pass fields to native navigation/clipboard APIs; never build a shell command. Navigation can be allowed in readonly documents; metadata commits require separate write and explicit audience disclosure authorization. A copy intent still goes through `LinkActivation.copy(request)` for safe locator/current private permission checks. Advisory canonical URLs and fetched titles never replace the stored activation identity.

`PublicLinkCachePolicy` mirrors Rust `ResolverLimits`: concurrency/queue/pending/cache entries and positive, negative and queue lifetimes are finite. `PrivateLinkCachePolicy` mirrors Rust `PrivateCachePolicy`: default offline lease is zero, maximum 300,000 ms; offline hits never renew it. These are adapter configuration records, not a browser cache implementation. Private keys include principal, tenant, authority, target, permission and policy revision; a host must invalidate on account changes/revoke/lock and keep fetched fields out of shared content by default.

The host's public transport must use standards-based URL admission and validate the **actual connected address** against protected IPv4/IPv6 ranges and configured allowlists before transmitting. Pin each validated address while preserving TLS hostname validation. Revalidate DNS/connection on every redirect and secondary icon/image request; redirects are disabled by default. Never forward cookies, ambient credentials or client authorization. Apply finite connect/total deadlines, compressed/decoded byte, content-type/media and redirect limits; abort oversized/slow work. A prepared port is not proof that a deployed network adapter enforces these obligations. Private catalog ports use current target grants and configured authorities and never fall back to privileged public fetching. Credentials remain inside host adapters. The existing Rust `editac_session::links` modules own backend URL/egress/parser/scheduler/private cache behavior; these TypeScript ports do not replace them.

Roadmaps 31 (iOS), 32 (Android), 33 (macOS), 34 (Windows), 35 (Linux) and 36 (TUI) wire these records to native text/status/asset presenters, explicit refresh, focus restoration, accessibility labels/actions and typed host navigation/clipboard dispatch. The profile manifest in `fixtures/link-presenters/platforms.json` names those integration points. `tests/link-public-exports.test.mjs` proves clean packed imports and headless state/authority/cancellation/readonly semantics for all six profiles; it does not claim their current implementation or OS qualification. Roadmap 26 owns portable contracts and browser integration; deployed adapter and platform qualification remain separately required.

### Selected Markdown table source

After explicitly registering `initMarkdown(...)` from `@edit-ac/markdown`, retain
source and ordered block owner IDs from the imported source representation:

```ts
const opening = engine.checkpoint(); // retain with source for later storage recovery
const baseline = engine.captureSourceBaseline(source, owners, {tables: true});
const {plan, source: formatted, changed} = baseline.prepareTableFormat(tableOwner, 'local:table-source');
try { session.storage.commitPrepared(plan); } finally { engine.releasePlan(plan); }
await session.storage.flush({target: 'local'});
// Uses current descriptor source after normal undo/redo, without serializing the document.
const currentSource = baseline.sourceWithCurrentTable(tableOwner);
const exactOriginal = baseline.originalSource;
baseline.dispose();
```

The host supplies existing write/table/protected-content policy and its normal
Session storage adapter. Preparation is pure; plans are single-use and reject
any intervening document revision, including a no-op format. Only the selected
retained top-level v1 GFM table is eligible; unsupported or ambiguous source
rejects. Adjacent source bytes and backing text/anchor identities remain exact.
Padding counts Unicode scalars, preserves LF/CRLF and EOF newline policy, and
retains the existing 1 MiB source/output limits. No automatic formatting occurs.
After reopening local storage, use
`engine.captureSourceBaseline(source, owners, {tables: true}, opening)` to recover
current source against the same retained opening representation. Markdown remains
optional; no parser is linked into the default engine. The source handle owns a
read-only checkpoint snapshot, not an editable document or a storage journal.
